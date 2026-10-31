import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const exec = promisify(execFile);

function hasZig(): boolean {
  try {
    execFileSync("zig", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const sources = [
  join(import.meta.dirname, "scr_text_pages.test.c"),
  join(import.meta.dirname, "scr_text_pages.c"),
];

/* The code-page move links alone (it needs only libc). Whether it moves the
 * code depends on the system's transparent huge page mode. glibc and musl
 * report the main program to dl_iterate_phdr under different names, so the
 * check runs against both: a glibc build with clang, and a static musl
 * build with zig (the compiler musl runtime packs use) where it is
 * installed. */
const lanes = [
  {
    name: "glibc",
    compiler: "clang",
    args: ["-fsanitize=undefined"],
    run: true,
  },
  {
    name: "musl",
    compiler: "zig",
    args: ["cc", "-target", `${process.arch === "arm64" ? "aarch64" : "x86_64"}-linux-musl`],
    run: process.platform === "linux" && hasZig(),
  },
];

for (const lane of lanes) {
  test.skipIf(process.platform !== "linux" || !lane.run)(
    `an opted-in program's code moves onto huge pages when the system allows them (${lane.name})`,
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "scriptc-text-pages-"));
      try {
        const bin = join(dir, "text-pages");
        await exec(lane.compiler, [
          ...lane.args,
          "-std=c11",
          "-O1",
          "-Wall",
          "-Wextra",
          "-D_GNU_SOURCE",
          ...sources,
          "-o",
          bin,
        ]);
        const mode = await readFile("/sys/kernel/mm/transparent_hugepage/enabled", "utf8").catch(
          () => "",
        );
        const allowed = mode.includes("[always]") || mode.includes("[madvise]");
        const result = await exec(bin, [], {
          env: { ...process.env, UBSAN_OPTIONS: "halt_on_error=1" },
        });
        expect(result.stdout).toBe(`text page checks passed: ${allowed ? "moved" : "kept"}\n`);
        expect(result.stderr).toBe("");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
}
