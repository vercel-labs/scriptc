import { execFile, spawnSync } from "node:child_process";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const testDir = import.meta.dirname;
const srcDir = join(testDir, "../src");
const vendorDir = join(testDir, "../vendor");
const buildDir = join(testDir, "build", "common-symbols");

/** COMMON globals in every runtime source compiled with `compiler`, in the
 * plain and worker configurations, as "file (defines): symbol" lines. */
async function commonSymbols(label: string, compiler: string[]): Promise<string[]> {
  const outDir = join(buildDir, label);
  await mkdir(outDir, { recursive: true });
  const sources = (await readdir(srcDir))
    .filter((name) => name.endsWith(".c") && !name.endsWith(".test.c"))
    .sort();
  const jobs = sources.flatMap((name) =>
    [[], ["-DSCR_WORKERS"]].map((defines) => ({ name, defines })),
  );
  const common: string[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const { name, defines } = jobs[next++]!;
      const output = join(outDir, `${name}${defines.join("")}.ll`);
      await execFileAsync(compiler[0]!, [
        ...compiler.slice(1),
        "-std=c11",
        "-O0",
        "-fcommon",
        "-S",
        "-emit-llvm",
        ...defines,
        `-I${join(vendorDir, "quickjs-ng")}`,
        `-I${join(vendorDir, "mbedtls", "include")}`,
        `-I${join(vendorDir, "brotli", "c", "include")}`,
        "-o",
        output,
        join(srcDir, name),
      ]);
      for (const match of (await readFile(output, "utf8")).matchAll(/^@(\S+) = common /gm)) {
        common.push(`${name}${defines.length > 0 ? ` (${defines.join(" ")})` : ""}: ${match[1]}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, availableParallelism()) }, worker));
  return common.sort();
}

// Library localization (abi.localize_runtime) keeps COMMON symbols global,
// so a runtime global written as a tentative definition (`T x;` at file
// scope with no initializer) is exported from every localized library
// archive on toolchains that emit tentative definitions as COMMON symbols,
// such as the macOS runtime build. Linux clang defaults to -fno-common, where
// the same declaration is an ordinary definition, so the library-multi
// symbol checks only catch it on macOS. These tests compile every runtime
// source with -fcommon, in the plain and worker configurations, and expect
// no COMMON symbols: every external runtime global needs an initializer.
test("runtime globals are not tentative definitions", async () => {
  const host = ["clang", ...(process.platform === "linux" ? ["-D_GNU_SOURCE"] : [])];
  expect(await commonSymbols("host", host)).toEqual([]);
});

// Some globals are declared only in __APPLE__ branches, so other hosts also
// compile the sources for aarch64-macos through zig's bundled macOS headers.
const zig = spawnSync("zig", ["version"], { encoding: "utf8" }).status === 0;
test.skipIf(process.platform === "darwin" || !zig)(
  "runtime globals are not tentative definitions on macOS targets",
  async () => {
    expect(await commonSymbols("aarch64-macos", ["zig", "cc", "-target", "aarch64-macos"])).toEqual(
      [],
    );
  },
);
