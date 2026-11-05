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

const source = join(import.meta.dirname, "scr_musl_malloc.test.c");
const flags = ["-std=c11", "-D_GNU_SOURCE", "-Wall", "-Wextra", "-Werror", "-pthread"];

async function run(build: (bin: string) => Promise<unknown>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-musl-malloc-"));
  try {
    const bin = join(dir, "musl-malloc");
    await build(bin);
    const result = await exec(bin, [], {
      timeout: 120000,
      env: { ...process.env, UBSAN_OPTIONS: "halt_on_error=1" },
    });
    expect(result.stdout).toBe("ok\n");
    expect(result.stderr).toBe("");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/* The musl lane's malloc family is header functions with prefixed names, so
 * the test compiles them with the host's clang on any Linux host: optimized,
 * with AddressSanitizer and UndefinedBehaviorSanitizer, and with
 * ThreadSanitizer. */
const lanes = [
  { name: "optimized", flags: ["-O2"] },
  { name: "sanitized", flags: ["-O1", "-g", "-fsanitize=address,undefined"] },
  { name: "thread-sanitized", flags: ["-O1", "-g", "-fsanitize=thread"] },
];
for (const lane of lanes)
  test.skipIf(process.platform !== "linux")(
    `musl lane malloc family: sizes, realloc, alignment, threads and fork (${lane.name})`,
    async () => {
      await run((bin) => exec("clang", [...flags, ...lane.flags, source, "-o", bin]));
    },
  );

/* A static x86_64 musl build defines the libc names over them, as
 * scr_musl.c does, so the program and libc allocate through them in place
 * of zig's allocator. */
test.skipIf(process.platform !== "linux" || process.arch !== "x64" || !(await hasZig()))(
  "musl lane malloc family replaces zig's allocator in a static musl executable",
  async () => {
    await run((bin) =>
      exec("zig", [
        "cc",
        "-target",
        "x86_64-linux-musl",
        "-static",
        "-O2",
        "-DSCR_MUSL_MALLOC_LIBC",
        ...flags,
        source,
        "-o",
        bin,
      ]),
    );
  },
);
