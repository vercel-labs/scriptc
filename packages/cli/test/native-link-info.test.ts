import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { release as osRelease, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import type { NativeLinkInfo } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const repoRoot = join(import.meta.dirname, "../../..");
const cliEntry = join(repoRoot, "packages/cli/src/main.ts");
const tsxLoader = join(dirname(require.resolve("tsx/package.json")), "dist/loader.mjs");
const supported = process.platform === "darwin" && process.arch === "arm64" &&
  Number.parseInt(osRelease().split(".", 1)[0] ?? "", 10) >= 24;
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function cli(args: string[]) {
  return execFileAsync(process.execPath, ["--import", tsxLoader, cliEntry, ...args], {
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-native-link-info-"));
  dirs.push(dir);
  const entry = join(dir, "main.ts");
  await writeFile(entry, 'console.log("external link");\n');
  return { dir, entry, object: join(dir, "app.o") };
}

test("print option validation is explicit", async () => {
  const { entry } = await fixture();
  await expect(cli(["build", entry, "--print=wat"]))
    .rejects.toMatchObject({ stderr: expect.stringContaining("unknown print kind") });
  await expect(cli(["build", entry, "--print=native-link-info", "--emit=llvm"]))
    .rejects.toMatchObject({ stderr: expect.stringContaining("requires --emit=obj") });
  await expect(cli(["run", entry, "--print=native-link-info"]))
    .rejects.toMatchObject({ stderr: expect.stringContaining("is a build option") });
  await expect(cli(["build", entry, "--print=native-link-info", "--subsystem=windows"]))
    .rejects.toMatchObject({ stderr: expect.stringContaining("subsystem is supported only for executable output") });
});

describe.runIf(supported)("macOS arm64 native link info", () => {
  test("prints a stable cache-independent source-pack recipe", async () => {
    const { entry, object } = await fixture();
    const { stdout, stderr } = await cli([
      "build", entry, "--print=native-link-info", "-o", object,
    ]);
    expect(stderr).toBe("");
    const info = JSON.parse(stdout) as NativeLinkInfo;
    expect(info).toMatchObject({
      schema: "scriptc.native-link-info.v1",
      format: 1,
      object_abi: { stability: "experimental", compatibility: "exact-runtime-version" },
      target: {
        name: "macos-arm64",
        llvm_triple: "arm64-apple-macosx14.0.0",
        object_format: "macho",
        minimum_os: "14.0",
      },
      program: { object, entry_symbol: "main" },
      runtime_abi: { version: 1, marker: "scr_runtime_abi_v1" },
      runtime_pack: {
        kind: "source",
        package: "@scriptc/runtime",
        path_base: "runtime_pack.root",
      },
      link: { system_libraries: ["System"], frameworks: [] },
    });
    expect(info.runtime_pack.root).not.toContain("node_modules/.cache");
    expect(info.link.input_order.join("\n")).not.toContain("node_modules/.cache");
    const runtime = info.runtime_pack.source_sets.find((set) => set.name === "runtime");
    expect(runtime?.sources).toEqual(expect.arrayContaining([
      "src/scr_console.c",
      "src/scr_async.c",
      "src/scr_cycle.c",
    ]));
    await expect(readFile(object)).resolves.toBeInstanceOf(Buffer);
  });

  test("printing link info emits an object without invoking external tools", async () => {
    const { dir, entry, object } = await fixture();
    const traps = join(dir, "traps");
    await execFileAsync("mkdir", [traps]);
    const trapLog = join(dir, "trap.log");
    for (const tool of ["clang", "cc", "gcc", "zig", "ar", "ld", "xcrun"]) {
      const path = join(traps, tool);
      await writeFile(path, `#!/bin/sh\nprintf '${tool}\\n' >> '${trapLog}'\nexit 97\n`);
      await chmod(path, 0o755);
    }
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cliEntry, "build", entry, "--print=native-link-info", "-o", object],
      {
        env: {
          ...process.env,
          PATH: `${traps}:${process.env["PATH"] ?? ""}`,
          SCRIPTC_CACHE_DIR: join(dir, "cache"),
        },
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    expect(stderr).toBe("");
    expect((JSON.parse(stdout) as NativeLinkInfo).program.object).toBe(object);
    await expect(readFile(trapLog)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("an out-of-tree C-driver build consumes the reported object and runtime pack", async () => {
    const { dir, entry, object } = await fixture();
    const { stdout } = await cli([
      "build", entry, "--print=native-link-info", "-o", object,
    ]);
    const info = JSON.parse(stdout) as NativeLinkInfo;
    const runtime = info.runtime_pack.source_sets.find((set) => set.name === "runtime")!;
    const executable = join(dir, "app");
    await execFileAsync("clang", [
      ...runtime.c_flags,
      ...runtime.defines.map((define) => `-D${define}`),
      ...runtime.include_directories.flatMap((path) => ["-I", join(info.runtime_pack.root, path)]),
      ...runtime.sources.map((path) => join(info.runtime_pack.root, path)),
      object,
      ...info.link.system_libraries.map((name) => `-l${name}`),
      "-o", executable,
    ]);
    await expect(execFileAsync(executable, [], { encoding: "utf8" }))
      .resolves.toMatchObject({ stdout: "external link\n", stderr: "" });
  }, 30_000);

  test("a mismatched runtime ABI fails at link time through the versioned marker", async () => {
    const { dir, entry, object } = await fixture();
    await cli(["build", entry, "--emit=obj", "-o", object]);
    const stub = join(dir, "wrong-runtime.c");
    await writeFile(stub, [
      "void scr_runtime_abi_v2(void) {}",
      "void scr_console_log(void) {}",
      "void scr_init(void) {}",
      "void scr_lib_init(void) {}",
      "void scr_str_release(void) {}",
      "void scr_str_retain_v(void) {}",
      "void scr_error_vts(void) {}",
      "",
    ].join("\n"));
    const error = await execFileAsync("clang", [
      "-target", "arm64-apple-macosx14.0.0", object, stub, "-o", join(dir, "bad"),
    ]).then(() => null, (failure: { stderr?: string }) => failure);
    expect(error?.stderr).toContain("scr_runtime_abi_v1");
  });
});
