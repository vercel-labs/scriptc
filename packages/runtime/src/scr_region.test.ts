import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { EXECUTABLE_RUNTIME_SOURCES } from "../../compiler/src/backend/native-toolchain.js";

const exec = promisify(execFile);

/* Every release attempt of a mode, in order, as "<region> <outcome>"
 * (SCRIPTC_REGION_STATS=1), and the per-thread summary lines. */
const OWNED_ATTEMPTS = [
  "1 freed",
  "2 kept",
  "2 freed",
  "3 freed",
  "4 kept",
  "5 freed",
  "4 freed",
  "6 freed",
  "7 freed",
  "8 kept",
  // 9 frees on the check before the pass over the heap that 8 needs.
  "9 freed",
  "8 freed",
  "10 kept",
  "12 freed",
  "11 freed",
  "10 freed",
  "13 freed",
  "14 freed",
  "15 kept",
  "16 freed",
  "15 freed",
  "17 freed",
];
const OWNED_STDOUT = [
  "an owned graph of every walked shape is freed with its region",
  "an outside reference keeps a region until it is dropped",
  "ordinary objects referenced from outside keep what they reach",
  "owned cycles and dead outside cycles do not keep a region",
  "references the walk cannot explain keep a region",
  "regions in use or referenced by other regions are kept",
  "allocation continues per class across region switches",
  "a kept region is attempted again after enough region allocation",
];
const RETAINED_ATTEMPTS = ["1 kept", "1 freed", "2 freed", "3 pinned", "4 freed"];
const RETAINED_STDOUT = [
  "objects outside every live region go to the default region",
  "a published object pins its region",
];

function attempts(stderr: string): {
  attempts: string[];
  summaries: string[];
  heapPasses: number[];
  other: string[];
} {
  const out = {
    attempts: [] as string[],
    summaries: [] as string[],
    heapPasses: [] as number[],
    other: [] as string[],
  };
  for (const line of stderr.split("\n")) {
    if (line === "") continue;
    const m = /^scriptc region (\d+): (freed|kept|pinned)\b/.exec(line);
    if (m) out.attempts.push(`${m[1]} ${m[2]}`);
    else if (line.startsWith("scriptc regions: ")) out.summaries.push(line);
    else if (line.startsWith("scriptc region heap passes: "))
      out.heapPasses.push(Number(line.slice("scriptc region heap passes: ".length)));
    else out.other.push(line);
  }
  return out;
}

// The size-class allocator build, the sanitized lane's build (ASan and the
// RC audit, whose exit check then proves that freeing a region freed every
// ordinary object it owned, and where freed chunks fault), and worker
// executables under ThreadSanitizer.
describe.skipIf(process.platform === "win32")("counted lifetime regions", () => {
  const build = async (dir: string, name: string, flags: string[]): Promise<string> => {
    const bin = join(dir, name);
    await exec("clang", [
      "-std=c11",
      "-O1",
      "-pthread",
      "-Wno-deprecated-declarations",
      ...(process.platform === "linux" ? ["-D_GNU_SOURCE"] : []),
      ...flags,
      ...["scr_region.test.c", ...EXECUTABLE_RUNTIME_SOURCES].map((source) =>
        join(import.meta.dirname, source),
      ),
      ...(process.platform === "linux" ? ["-lm"] : []),
      "-o",
      bin,
    ]);
    return bin;
  };
  const run = async (bin: string, mode: string, extra: Record<string, string> = {}) =>
    exec(bin, [mode], {
      timeout: 60000,
      env: {
        ...process.env,
        ...extra,
        SCRIPTC_REGION_STATS: "1",
        ASAN_OPTIONS: "halt_on_error=1",
        TSAN_OPTIONS: "halt_on_error=1",
        UBSAN_OPTIONS: "halt_on_error=1",
      },
    });

  test.each([
    ["size-class", ["-fsanitize=undefined"]],
    ["sanitized", ["-fsanitize=address,undefined", "-DSCR_RC_AUDIT"]],
  ])("release walks, keeps and frees regions (%s)", async (lane, flags) => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-region-"));
    try {
      const bin = await build(dir, "region", flags);
      const owned = await run(bin, "regions");
      const sanitized = lane === "sanitized";
      expect(owned.stdout.trim().split("\n")).toEqual([
        ...OWNED_STDOUT,
        sanitized
          ? "sanitized builds fault on any access to a freed region"
          : "a freed region's chunk serves the next region, cleared",
      ]);
      const ownedStats = attempts(owned.stderr);
      expect(ownedStats.attempts).toEqual([
        ...OWNED_ATTEMPTS,
        ...(sanitized ? ["18 freed"] : ["18 freed", "19 freed"]),
      ]);
      const n = sanitized ? 18 : 19;
      expect(ownedStats.summaries).toEqual([
        `scriptc regions: ${n} created, ${n} released, ${n} freed, 0 pinned, 0 kept`,
      ]);
      // No RC audit line: every region was freed, so the strict exit audit ran.
      expect(ownedStats.other).toEqual([]);

      // Optimized runtimes leave the reports out (RC-audit ones keep them)
      // and say so once.
      if (!sanitized) {
        const optimized = await run(bin, "debug", { SCRIPTC_REGION_DEBUG: "1" });
        expect(optimized.stderr).toContain(
          "scriptc: SCRIPTC_REGION_DEBUG reports need a build with --optimization=dev\n",
        );
      }
      const debugBin = sanitized
        ? bin
        : await build(dir, "region-debug", [...flags, "-DSCR_RGN_DEBUG"]);
      const debug = await run(debugBin, "debug", { SCRIPTC_REGION_DEBUG: "1" });
      expect(debug.stdout.trim()).toBe("the debug report names what keeps a region");
      const report = debug.stderr
        .split("\n")
        .filter((line) => !line.startsWith("scriptc region") || line.endsWith("keep it:"));
      expect(
        report.filter(
          (line) =>
            line !== "" &&
            !line.startsWith("scriptc regions:") &&
            !line.startsWith("scriptc RC audit"),
        ),
      ).toEqual([
        "scriptc region 1: 2 references from outside keep it:",
        "  1 not found by the walk, to objects in a chunk holding Node",
        "  an array held by Node.kids, with 2 references, 1 of them from what the region owns",
      ]);

      const retained = await run(bin, "retained");
      expect(retained.stdout.trim().split("\n")).toEqual(RETAINED_STDOUT);
      const retainedStats = attempts(retained.stderr);
      expect(retainedStats.attempts).toEqual(RETAINED_ATTEMPTS);
      expect(retainedStats.summaries).toEqual([
        "scriptc regions: 4 created, 4 released, 3 freed, 1 pinned, 0 kept",
      ]);
      expect(retainedStats.other).toEqual(
        sanitized ? ["scriptc RC audit skipped: 5 program-lifetime object(s) never freed"] : [],
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("worker threads free their own regions under ThreadSanitizer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-region-"));
    try {
      const bin = await build(dir, "region-threads", ["-fsanitize=thread", "-DSCR_WORKERS"]);
      const result = await run(bin, "threads");
      expect(result.stdout).toBe(
        "threads free their own regions; a shared published object pins its region\n",
      );
      const stats = attempts(result.stderr);
      expect(stats.attempts.filter((a) => a.endsWith(" freed"))).toHaveLength(80);
      expect(stats.attempts.filter((a) => !a.endsWith(" freed"))).toEqual(["1 pinned"]);
      expect(stats.summaries).toEqual(
        Array(4).fill("scriptc regions: 20 created, 20 released, 20 freed, 0 pinned, 0 kept"),
      );
      expect(stats.heapPasses).toEqual([0, 0, 0, 0]);
      expect(stats.other).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
