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

/* The musl lane's floor, ceil, trunc, round, sqrt, fmod, scalbn, ldexp and
 * frexp (scr_glibc_math.c, built for x86_64-linux-musl with zig) answer
 * the same result bits as glibc's libm over the inputs
 * scr_glibc_math.test.c prints. */
test.skipIf(process.platform !== "linux" || process.arch !== "x64" || !(await hasZig()))(
  "the musl lane's exactly specified libm functions answer what glibc's do",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-musl-math-"));
    try {
      const source = join(import.meta.dirname, "scr_glibc_math.test.c");
      const reference = join(dir, "reference");
      const musl = join(dir, "musl");
      await exec("clang", ["-std=c11", "-O2", source, "-o", reference, "-lm"]);
      await exec("zig", [
        "cc",
        "-target",
        "x86_64-linux-musl",
        "-std=c11",
        "-O2",
        "-DSCR_MUSL",
        source,
        join(import.meta.dirname, "scr_glibc_math.c"),
        "-o",
        musl,
      ]);
      const expected = (await exec(reference, [])).stdout;
      const actual = (await exec(musl, [])).stdout;
      expect(actual.split("\n").length).toBeGreaterThan(500);
      expect(actual).toBe(expected);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
