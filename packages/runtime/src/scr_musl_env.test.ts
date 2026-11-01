import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const exec = promisify(execFile);

async function hasZig(): Promise<boolean> {
  try {
    await exec("zig", ["version"]);
    return true;
  } catch {
    return false;
  }
}

const source = join(import.meta.dirname, "scr_musl_env.test.c");
const flags = ["-std=c11", "-D_GNU_SOURCE", "-Wall", "-Wextra", "-Werror"];

async function run(build: (bin: string) => Promise<unknown>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-musl-env-"));
  try {
    const bin = join(dir, "musl-env");
    await build(bin);
    const result = await exec(bin, [], {
      timeout: 120000,
      env: { ...process.env, SCR_MUSL_ENV_TEST: "on", UBSAN_OPTIONS: "halt_on_error=1" },
    });
    expect(result.stdout).toBe("ok\n");
    expect(result.stderr).toBe("");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/* The musl lane's strcmp, strncmp and getenv are header functions with
 * prefixed names, so the test compiles them with the host's clang on any
 * Linux host: optimized, and with AddressSanitizer and
 * UndefinedBehaviorSanitizer. */
const lanes = [
  { name: "optimized", flags: ["-O2"] },
  { name: "sanitized", flags: ["-O1", "-g", "-fsanitize=address,undefined"] },
];
for (const lane of lanes)
  test.skipIf(process.platform !== "linux")(
    `musl lane strcmp, strncmp and getenv match musl's (${lane.name})`,
    async () => {
      await run((bin) => exec("clang", [...flags, ...lane.flags, source, "-o", bin]));
    },
  );

/* A static x86_64 musl build defines the libc names over them, as
 * scr_musl.c does, in place of zig's strcmp and strncmp and musl's getenv. */
test.skipIf(process.platform !== "linux" || process.arch !== "x64" || !(await hasZig()))(
  "musl lane getenv replaces musl's in a static musl executable",
  async () => {
    await run((bin) =>
      exec("zig", [
        "cc",
        "-target",
        "x86_64-linux-musl",
        "-static",
        "-O2",
        "-DSCR_MUSL_ENV_LIBC",
        ...flags,
        source,
        "-o",
        bin,
      ]),
    );
  },
);
