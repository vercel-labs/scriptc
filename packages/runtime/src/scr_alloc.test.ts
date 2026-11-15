import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const exec = promisify(execFile);

// The size-class allocator is compiled out under AddressSanitizer, so the
// UBSan-only build is the one that exercises it; the ASan build pins the
// system-allocator bypass the sanitizer lane relies on.
// Worker executables (-DSCR_WORKERS) give each script thread its own arena;
// the ThreadSanitizer build checks the cross-thread handoff for races. The
// last build runs with glibc's memory tagging tunable set, which turns the
// thread-heap huge-page policy off.
test.each([
  ["size-class", ["-fsanitize=undefined"], {}],
  ["system", ["-fsanitize=address,undefined"], {}],
  ["size-class workers", ["-fsanitize=undefined", "-DSCR_WORKERS", "-pthread"], {}],
  ["size-class workers", ["-fsanitize=thread", "-DSCR_WORKERS", "-pthread"], {}],
  [
    "size-class workers",
    ["-fsanitize=undefined", "-DSCR_WORKERS", "-pthread"],
    { GLIBC_TUNABLES: "glibc.mem.tagging=3" },
  ],
  // Slices of two chunks, which the checks outgrow.
  ["size-class", ["-fsanitize=undefined", "-DSCR_SA_SLICE_SHIFT=23"], {}],
  // A window of four chunks, which the checks fill.
  ["small window", ["-fsanitize=undefined", "-DSCR_SA_WINDOW_TEST_CHUNKS=4"], {}],
  [
    "small window",
    ["-fsanitize=undefined", "-DSCR_SA_WINDOW_TEST_CHUNKS=4", "-DSCR_WORKERS", "-pthread"],
    {},
  ],
])("small-object allocator contracts hold (%s, %j, %j)", async (mode, sanitize, extraEnv) => {
  const scratch = await mkdtemp(join(tmpdir(), "scriptc-alloc-"));
  try {
    const binary = join(scratch, "alloc");
    await exec("clang", [
      "-std=c11",
      "-O1",
      "-Wall",
      "-Wextra",
      // Linux runtime packs compile with _GNU_SOURCE, which exposes the
      // madvise advice the page policy uses; build the checks the same way.
      ...(process.platform === "linux" ? ["-D_GNU_SOURCE"] : []),
      ...sanitize,
      join(import.meta.dirname, "scr_alloc.test.c"),
      join(import.meta.dirname, "scr_alloc.c"),
      "-o",
      binary,
    ]);
    const result = await exec(binary, [], {
      env: {
        ...process.env,
        ASAN_OPTIONS: "halt_on_error=1",
        TSAN_OPTIONS: "halt_on_error=1",
        UBSAN_OPTIONS: "halt_on_error=1",
        ...extraEnv,
      },
    });
    expect(result.stdout).toBe(`allocator checks passed: ${mode}\n`);
    expect(result.stderr).toBe("");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

// The window's start is drawn per process, a whole number of 4 MiB chunks
// past its lowest address: runs differ, and a process started with
// address-space randomization off (`setarch -R`, as gdb starts programs)
// keeps the lowest start.
test.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
  "the window starts at a different address from run to run",
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), "scriptc-alloc-"));
    try {
      const binary = join(scratch, "alloc");
      await exec("clang", [
        "-std=c11",
        "-O1",
        ...(process.platform === "linux" ? ["-D_GNU_SOURCE"] : []),
        join(import.meta.dirname, "scr_alloc.test.c"),
        join(import.meta.dirname, "scr_alloc.c"),
        "-o",
        binary,
      ]);
      const start = async (command: string, args: string[]): Promise<bigint> =>
        BigInt(`0x${(await exec(command, [...args, "window-start"])).stdout.trim()}`);
      const chunk = 4n << 20n;
      const low = process.platform === "linux" ? 4n << 30n : (1n << 40n) + chunk;
      const starts: bigint[] = [];
      for (let run = 0; run < 8; run++) starts.push(await start(binary, []));
      for (const at of starts) {
        expect(at >= low && at < low + 1024n * chunk, at.toString(16)).toBe(true);
        expect((at - low) % chunk).toBe(0n);
      }
      // Eight equal draws of 1024 happen once in 10^21 runs.
      expect(new Set(starts).size).toBeGreaterThan(1);
      if (process.platform !== "linux") return;
      // A seccomp filter may refuse the personality (Docker's default does).
      const fixed = await exec("setarch", ["-R", "true"]).then(
        () => true,
        () => false,
      );
      if (!fixed) return;
      for (let run = 0; run < 3; run++) expect(await start("setarch", ["-R", binary])).toBe(low);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
);
