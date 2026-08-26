import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { deserializeModule } from "../../compiler/src/ir/serialize.js";
import { validateModule } from "../../compiler/src/ir/validate.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const repoRoot = join(import.meta.dirname, "../../..");
const cliEntry = join(repoRoot, "packages/cli/src/main.ts");
const tsxLoader = join(dirname(require.resolve("tsx/package.json")), "dist/loader.mjs");
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-cli-source-output-"));
  dirs.push(dir);
  const entry = join(dir, "hello.ts");
  await writeFile(entry, 'console.log("hello");\n');
  return { dir, entry };
}

function cli(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return execFileAsync(process.execPath, ["--import", tsxLoader, cliEntry, ...args], {
    env,
    maxBuffer: 4 * 1024 * 1024,
  });
}

test("default and explicit paths identify each source primary artifact", async () => {
  const { dir, entry } = await fixture();
  const expected = { ir: "hello.ir.json", c: "hello.c", llvm: "hello.ll" } as const;
  for (const kind of ["ir", "c", "llvm"] as const) {
    const result = await cli(["build", entry, `--emit=${kind}`]);
    const path = join(dir, ".scriptc", expected[kind]);
    expect(result.stdout).toBe(`${path}\n`);
    expect(await readdir(join(dir, ".scriptc"))).toEqual([expected[kind]]);
  }
  const exact = join(dir, "artifact.with-custom-suffix");
  const result = await cli(["build", entry, "--emit=llvm", "-o", exact]);
  expect(result.stdout).toBe(`${exact}\n`);
  expect(await readFile(exact, "utf8")).toContain("define i32 @main");
});

test("IR CLI output round-trips through the public parser and validator", async () => {
  const { dir, entry } = await fixture();
  const path = join(dir, "hello.json");
  await cli(["build", entry, "--emit=ir", "-o", path]);
  expect(validateModule(deserializeModule(await readFile(path, "utf8")))).toEqual([]);
});

test("source outputs never execute compiler, archiver, or linker traps", async () => {
  const { dir, entry } = await fixture();
  const traps = join(dir, "traps");
  const trapLog = join(dir, "trap.log");
  await mkdir(traps);
  for (const tool of ["clang", "cc", "gcc", "zig", "ar", "ld", "link", "link.exe", "xcrun"]) {
    const path = join(traps, tool);
    await writeFile(path, `#!/bin/sh\nprintf '${tool}\\n' >> '${trapLog}'\nprintf '${tool} trap executed\\n' >&2\nexit 97\n`);
    await chmod(path, 0o755);
  }
  const env = {
    ...process.env,
    PATH: `${traps}${delimiter}${process.env["PATH"] ?? ""}`,
    SCRIPTC_CC: "zigcc",
    SCRIPTC_TARGET: "aarch64-apple-ios",
    SCRIPTC_CACHE_DIR: join(dir, "cache-must-not-exist"),
  };
  for (const kind of ["ir", "c", "llvm"] as const) {
    const path = join(dir, `hello.${kind}`);
    await expect(cli(["build", entry, `--emit=${kind}`, "-o", path], env)).resolves.toMatchObject({
      stderr: "",
      stdout: `${path}\n`,
    });
  }
  await expect(readdir(env.SCRIPTC_CACHE_DIR)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(trapLog, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("--emit-ir remains additive but reports its deprecation", async () => {
  const { dir, entry } = await fixture();
  const executable = join(dir, process.platform === "win32" ? "hello.exe" : "hello-bin");
  const result = await cli(["build", entry, "--emit-ir", "-o", executable]);
  expect(result.stderr).toContain("--emit-ir is deprecated");
  expect(await readFile(join(dir, "hello.ir.json"), "utf8")).toContain('"irVersion"');
});

test("run and incompatible compatibility flags reject non-executable outputs", async () => {
  const { entry } = await fixture();
  await expect(cli(["run", entry, "--emit=c"])).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("scriptc run requires --emit=exe"),
  });
  await expect(cli(["build", entry, "--emit=llvm", "--emit-ir"])).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("--emit-ir cannot be combined"),
  });
});
