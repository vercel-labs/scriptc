import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { release as osRelease, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { compile, compileC } from "../src/index.js";
import { MACOS_ARM64_TARGET } from "../src/backend/targets.js";

const execFileAsync = promisify(execFile);
const supported = process.platform === "darwin" && process.arch === "arm64" &&
  Number.parseInt(osRelease().split(".", 1)[0] ?? "", 10) >= 24;
const repoRoot = join(import.meta.dirname, "../../..");
const require = createRequire(import.meta.url);
const helperPackage = supported
  ? require.resolve("@scriptc/llvm-darwin-arm64/package.json")
  : "";
const helper = supported
  ? join(dirname(helperPackage), "bin", "scriptc-llvm-codegen")
  : "";
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function helperArgs(input: string, output: string, target = MACOS_ARM64_TARGET.llvmTriple) {
  return [
    "emit", "--input", input, "--output", output,
    "--filetype", "obj", "--target", target,
    "--opt-level", "2", "--relocation-model", "pic",
    "--diagnostic-format", "json", "--source-path", "/src/original.ts",
  ];
}

async function run(command: string, args: string[]) {
  try {
    const result = await execFileAsync(command, args, { encoding: "buffer" });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as { stdout?: Buffer; stderr?: Buffer; code?: number };
    return {
      stdout: failure.stdout ?? Buffer.alloc(0),
      stderr: failure.stderr ?? Buffer.alloc(0),
      exitCode: typeof failure.code === "number" ? failure.code : 1,
    };
  }
}

describe.runIf(supported)("LLVM native helper integration", () => {
  test("malformed IR and unsupported targets are structured and preserve caller output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-helper-errors-"));
    dirs.push(dir);
    const input = join(dir, "bad.ll");
    const output = join(dir, "out.o");
    await writeFile(input, "this is not LLVM IR\n");
    await writeFile(output, "existing\n");
    const malformed = await run(helper, helperArgs(input, output));
    expect(malformed.exitCode).toBe(1);
    expect(JSON.parse(malformed.stderr.toString("utf8"))).toMatchObject({
      ok: false,
      code: "invalid_ir",
    });
    expect(await readFile(output, "utf8")).toBe("existing\n");

    await writeFile(input, "define i32 @answer() { ret i32 42 }\n");
    const unsupported = await run(helper, helperArgs(input, output, "x86_64-apple-macosx14.0.0"));
    expect(JSON.parse(unsupported.stderr.toString("utf8"))).toMatchObject({
      ok: false,
      code: "unsupported_target",
    });
    expect(await readFile(output, "utf8")).toBe("existing\n");
  });

  test("LLVM fatal diagnostics remain process-isolated JSON", async () => {
    const result = await execFileAsync(helper, ["version", "--format=json"], {
      encoding: "utf8",
      env: { ...process.env, SCRIPTC_LLVM_TEST_FATAL: "1" },
    }).then(
      () => null,
      (error: { stderr?: string; code?: number }) => error,
    );
    expect(result?.code).toBe(70);
    expect(JSON.parse(result?.stderr ?? "{}")).toMatchObject({
      ok: false,
      code: "llvm_fatal",
    });
  });

  test("an interrupted helper cannot truncate an existing caller artifact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-helper-interrupt-"));
    dirs.push(dir);
    const input = join(dir, "large.ll");
    const output = join(dir, "out.o");
    const functions = Array.from(
      { length: 100_000 },
      (_, i) => `define i32 @f${i}() { ret i32 ${i} }`,
    ).join("\n");
    await writeFile(input, `${functions}\n`);
    await writeFile(output, "existing\n");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(helper, helperArgs(input, output), { stdio: "ignore" });
      child.once("error", reject);
      child.once("spawn", () => child.kill("SIGKILL"));
      child.once("close", () => resolve());
    });
    expect(await readFile(output, "utf8")).toBe("existing\n");
  });

  test("helper and clang objects have matching metadata and identical runtime behavior", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-helper-parity-"));
    dirs.push(dir);
    const entry = join(repoRoot, "tests/corpus/001-hello.ts");
    const helperExe = join(dir, "helper-program");
    const result = await compile(entry, {
      outDir: dir,
      outPath: helperExe,
      backend: "llvm",
      nativeProgramObject: true,
    });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
    const llvm = join(dir, "001-hello.ll");
    const helperObject = join(dir, "001-hello.helper.o");
    const clangObject = join(dir, "001-hello.clang.o");
    await execFileAsync("clang", [
      "-O2", "-Wno-override-module", "-target", MACOS_ARM64_TARGET.llvmTriple,
      "-c", llvm, "-o", clangObject,
    ]);

    for (const object of [helperObject, clangObject]) {
      await expect(execFileAsync("file", [object], { encoding: "utf8" }))
        .resolves.toMatchObject({ stdout: expect.stringContaining("Mach-O 64-bit object arm64") });
      const loadCommands = (await execFileAsync("otool", ["-l", object], { encoding: "utf8" })).stdout;
      expect(loadCommands).toMatch(/LC_BUILD_VERSION[\s\S]*minos 14\.0/);
    }
    const sections = async (object: string) =>
      [...(await execFileAsync("otool", ["-l", object], { encoding: "utf8" })).stdout
        .matchAll(/sectname (\S+)[\s\S]*?segname (\S+)/g)]
        .map((match) => `${match[2]},${match[1]}`).sort();
    for (const object of [helperObject, clangObject]) {
      expect(await sections(object)).toEqual(expect.arrayContaining([
        "__TEXT,__text",
        "__TEXT,__eh_frame",
        "__LD,__compact_unwind",
      ]));
    }
    const relocations = async (object: string) =>
      (await execFileAsync("otool", ["-rv", object], { encoding: "utf8" })).stdout
        .split("\n")
        .filter((line) => /\b(?:BR26|PAGE21|PAGOF12|GOTLDP|GOTLDPOF|SUB|UNSIGND)\b/.test(line))
        .map((line) => line.replace(/^\S+\s+/, "").trim())
        .sort();
    const [helperRelocations, clangRelocations] = await Promise.all([
      relocations(helperObject), relocations(clangObject),
    ]);
    for (const kind of ["BR26", "PAGE21", "PAGOF12", "GOTLDP", "GOTLDPOF", "SUB", "UNSIGND"]) {
      expect(helperRelocations.some((line) => line.includes(kind)), `helper lacks ${kind}`)
        .toBe(clangRelocations.some((line) => line.includes(kind)));
    }
    const symbols = async (object: string, args: string[]) =>
      (await execFileAsync("nm", [...args, object], { encoding: "utf8" })).stdout
        .trim().split("\n").filter(Boolean).sort();
    expect(await symbols(helperObject, ["-u"]))
      .toEqual(await symbols(clangObject, ["-u"]));
    expect(await symbols(helperObject, ["-gU"]))
      .toEqual(await symbols(clangObject, ["-gU"]));
    expect(await symbols(helperObject, ["-u"])).toContain("_scr_runtime_abi_v1");

    const clangExe = join(dir, "clang-program");
    const linkDriver = join(dir, "clang-driver.c");
    await writeFile(linkDriver, "/* clang object link driver */\n");
    await compileC({ cPath: linkDriver, outPath: clangExe, linkInputs: [clangObject] });
    const [helperRun, clangRun, nodeRun] = await Promise.all([
      run(helperExe, []),
      run(clangExe, []),
      run(process.execPath, [entry]),
    ]);
    expect(helperRun).toEqual(nodeRun);
    expect(clangRun).toEqual(nodeRun);
  });

  test("helper-object validation isolates concurrent link inputs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-helper-concurrent-"));
    dirs.push(dir);
    const firstEntry = join(dir, "first", "main.ts");
    const secondEntry = join(dir, "second", "main.ts");
    await Promise.all([mkdir(dirname(firstEntry)), mkdir(dirname(secondEntry))]);
    await Promise.all([
      writeFile(firstEntry, 'console.log("first concurrent helper");\n'),
      writeFile(secondEntry, 'console.log("second concurrent helper");\n'),
    ]);
    const build = (entry: string, output: string) => compile(entry, {
      outDir: dir,
      outPath: output,
      backend: "llvm",
      nativeProgramObject: true,
    });
    const firstExe = join(dir, "first-program");
    const secondExe = join(dir, "second-program");
    const [first, second] = await Promise.all([
      build(firstEntry, firstExe),
      build(secondEntry, secondExe),
    ]);
    if (!first.ok || !second.ok) throw new Error("concurrent helper builds failed");
    const [firstRun, secondRun] = await Promise.all([
      run(firstExe, []),
      run(secondExe, []),
    ]);
    expect(firstRun).toMatchObject({ stdout: Buffer.from("first concurrent helper\n"), exitCode: 0 });
    expect(secondRun).toMatchObject({ stdout: Buffer.from("second concurrent helper\n"), exitCode: 0 });
  });

  test("partial executable-cache hits still emit the program object through the helper", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-helper-cache-hit-"));
    dirs.push(dir);
    const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
    const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
    const oldFatal = process.env["SCRIPTC_LLVM_TEST_FATAL"];
    try {
      process.env["SCRIPTC_CACHE_DIR"] = join(dir, "cache");
      delete process.env["SCRIPTC_NO_CACHE"];
      delete process.env["SCRIPTC_LLVM_TEST_FATAL"];
      const options = {
        outDir: dir,
        outPath: join(dir, "program"),
        backend: "llvm" as const,
        nativeProgramObject: true,
      };
      const first = await compile(join(repoRoot, "tests/corpus/001-hello.ts"), options);
      if (!first.ok) throw new Error(first.diagnostics.map((d) => d.message).join("\n"));
      await rm(join(dir, "cache", "native-codegen-v1"), { recursive: true, force: true });

      // Helper-object links deliberately retain a partial early-cache entry
      // because the caller-owned object disables final-binary caching. Evict
      // the independent helper-object cache so the hit must regenerate that
      // object rather than compiling the restored .ll directly through clang.
      process.env["SCRIPTC_LLVM_TEST_FATAL"] = "1";
      const second = await compile(join(repoRoot, "tests/corpus/001-hello.ts"), options);
      expect(second).toMatchObject({
        ok: false,
        diagnostics: [{ code: "SC3004", message: expect.stringContaining("LLVM fatal") }],
      });
    } finally {
      if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
      else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
      if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
      else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
      if (oldFatal === undefined) delete process.env["SCRIPTC_LLVM_TEST_FATAL"];
      else process.env["SCRIPTC_LLVM_TEST_FATAL"] = oldFatal;
    }
  });

  test("object emission preserves outbound FFI declarations as native C ABI references", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-helper-ffi-"));
    dirs.push(dir);
    const object = join(dir, "ffi.o");
    const result = await compile(join(repoRoot, "tests/ffi/main.ts"), {
      outDir: dir,
      outPath: object,
      outputKind: "obj",
      ffiProfilePath: join(repoRoot, "tests/ffi/profile.json"),
    });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
    const undefinedSymbols = (await execFileAsync("nm", ["-u", object], { encoding: "utf8" }))
      .stdout.trim().split("\n");
    expect(undefinedSymbols).toContain("_sf_scale");
    expect(undefinedSymbols).toContain("_sf_callback_mix");
    expect(undefinedSymbols).toContain("_scr_runtime_abi_v1");
  });
});
