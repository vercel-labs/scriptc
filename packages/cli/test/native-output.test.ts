import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const repoRoot = join(import.meta.dirname, "../../..");
const cliEntry = join(repoRoot, "packages/cli/src/main.ts");
const tsxLoader = join(dirname(require.resolve("tsx/package.json")), "dist/loader.mjs");
const supported = process.platform === "darwin" && process.arch === "arm64";
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-cli-native-output-"));
  dirs.push(dir);
  const entry = join(dir, "hello.ts");
  await writeFile(entry, 'console.log("native output");\n');
  return { dir, entry };
}

function cli(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return execFileAsync(process.execPath, ["--import", tsxLoader, cliEntry, ...args], {
    env,
    maxBuffer: 4 * 1024 * 1024,
  });
}

test("unsupported hosts fail with SC3002 before creating an artifact", async () => {
  if (supported) return;
  const { dir, entry } = await fixture();
  const output = join(dir, "hello.o");
  await expect(cli(["build", entry, "--emit=obj", "-o", output])).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("SC3002"),
  });
  await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
});

describe.runIf(supported)("macOS arm64 native outputs", () => {
  test("default names and exact paths identify assembly and object artifacts", async () => {
    const { dir, entry } = await fixture();
    for (const [kind, name] of [["asm", "hello.s"], ["obj", "hello.o"]] as const) {
      const result = await cli(["build", entry, `--emit=${kind}`]);
      expect(result.stdout).toBe(`${join(dir, ".scriptc", name)}\n`);
    }
    const exact = join(dir, "exact.custom");
    await cli(["build", entry, "--emit=obj", "-o", exact]);
    expect((await readFile(exact)).subarray(0, 4)).toEqual(Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));
  });

  test("asm and obj do not execute compiler, archiver, or linker traps", async () => {
    const { dir, entry } = await fixture();
    const traps = join(dir, "traps");
    await execFileAsync("mkdir", [traps]);
    const trapLog = join(dir, "trap.log");
    for (const tool of ["clang", "cc", "gcc", "zig", "ar", "ld", "xcrun"]) {
      const path = join(traps, tool);
      await writeFile(path, `#!/bin/sh\nprintf '${tool}\\n' >> '${trapLog}'\nexit 97\n`);
      await chmod(path, 0o755);
    }
    const env = {
      ...process.env,
      PATH: `${traps}:${process.env["PATH"] ?? ""}`,
      SCRIPTC_CACHE_DIR: join(dir, "cache"),
    };
    for (const kind of ["asm", "obj"] as const) {
      await expect(cli(["build", entry, `--emit=${kind}`, "-o", join(dir, `hello.${kind}`)], env))
        .resolves.toMatchObject({ stderr: "" });
    }
    await expect(readFile(trapLog)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("identical object inputs have deterministic hashes", async () => {
    const { dir, entry } = await fixture();
    const first = join(dir, "first.o");
    const second = join(dir, "second.o");
    await cli(["build", entry, "--emit=obj", "-o", first], {
      ...process.env,
      SCRIPTC_NO_CACHE: "1",
    });
    await cli(["build", entry, "--emit=obj", "-o", second], {
      ...process.env,
      SCRIPTC_NO_CACHE: "1",
    });
    const digest = (path: string) => readFile(path).then((bytes) =>
      createHash("sha256").update(bytes).digest("hex"));
    expect(await digest(first)).toBe(await digest(second));
  });

  test("sanitize refuses by name without publishing an object", async () => {
    const { dir, entry } = await fixture();
    const output = join(dir, "san.o");
    await expect(cli(["build", entry, "--emit=obj", "--sanitize", "-o", output]))
      .rejects.toMatchObject({
        code: 1,
        stderr: expect.stringMatching(/SC3002[\s\S]*AddressSanitizer/),
      });
    await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
