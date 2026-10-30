import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const testDir = import.meta.dirname;
const bin = join(testDir, "build", "test_array");

// Compiled once with ASan + the RC audit: the assertions in test_array.c
// include recursive-release checks (array of strings, array of arrays), and
// the sanitized run proves no leak/double-free across all of them.
beforeAll(async () => {
  await mkdir(join(testDir, "build"), { recursive: true });
  await execFileAsync("clang", [
    "-std=c11",
    "-O1",
    "-Wall",
    "-Wextra",
    "-fsanitize=address",
    "-DSCR_RC_AUDIT",
    "-o",
    bin,
    join(testDir, "test_array.c"),
    join(testDir, "../src/scr_array.c"),
    join(testDir, "../src/scr_publish.c"),
    // Checked-value collection equality shares the native JSON value runtime.
    join(testDir, "../src/scr_json.c"),
    join(testDir, "../src/scr_map.c"),
    join(testDir, "../src/scr_union.c"),
    join(testDir, "../src/scr_bigint.c"),
    join(testDir, "../src/scr_symbol.c"),
    join(testDir, "../src/scr_assert.c"),
    join(testDir, "../src/scr_closure.c"),
    join(testDir, "../src/scr_string.c"),
    join(testDir, "../src/scr_number.c"),
    join(testDir, "../src/scr_bytes.c"),
    join(testDir, "../src/scr_shared.c"),
    join(testDir, "../src/scr_lib.c"),
    join(testDir, "../src/scr_hash.c"),
    join(testDir, "../src/scr_console.c"),
    join(testDir, "../src/scr_path.c"),
    join(testDir, "../src/scr_url.c"),
    join(testDir, "../src/scr_url_params.c"),
    join(testDir, "../src/scr_error.c"),
    join(testDir, "../src/scr_exception.c"),
    join(testDir, "../src/scr_object.c"),
    join(testDir, "../src/scr_cycle.c"),
    join(testDir, "../src/scr_alloc.c"),
    join(testDir, "../src/scr_copying.c"),
    ...(process.platform === "linux" ? ["-D_GNU_SOURCE", "-lm"] : []),
  ]);
});

test("array runtime: push/pop/set/get, RC recursion, growth", async () => {
  const { stderr } = await execFileAsync(bin, []);
  expect(stderr.trim()).toMatch(/^(\d+)\/\1 cases passed$/);
});

// Proven-presence getters still trap on a hole; the shared scr_arr_has query
// lets higher-level lowering return undefined without reading uninitialized
// scalar storage.
test.each([
  ["--crash-get-oob", "array index 1 out of bounds (length 1)"],
  ["--crash-get-frac", "numeric property 0.5 is absent"],
  ["--crash-hole-read", "array index 1 is a hole (length 3)"],
  ["--crash-pop-empty", "pop() returned undefined"],
])("trap aborts (%s)", async (mode, message) => {
  const err = await execFileAsync(bin, [mode]).then(
    () => {
      throw new Error(`expected ${mode} to abort`);
    },
    (e: Error & { signal?: string; stderr?: string }) => e,
  );
  expect(err.signal).toBe("SIGABRT");
  expect(err.stderr).toContain(`scriptc: RangeError: ${message}`);
});

function mutationOracle(mode: number): string {
  const lines: string[] = [];
  for (let kind = 0; kind < 3; kind++)
    for (let n = 0; n <= 4; n++) {
      for (let pattern = 0; pattern < 3 ** n; pattern++)
        for (let level = 0; level < 4; level++)
          for (
            let op = 0;
            op < (mode === 4 ? 2 : mode === 3 ? 16 : mode === 2 ? 22 : mode === 1 ? 2 : 8);
            op++
          ) {
            const a: Array<number | boolean | string | undefined> = new Array(n);
            let digits = pattern;
            for (let i = 0; i < n; i++, digits = Math.floor(digits / 3)) {
              const state = digits % 3;
              if (state === 1) a[i] = undefined;
              if (state === 2)
                a[i] = kind === 0 ? i + 1 : kind === 1 ? Boolean((i + 1) % 2) : String(i + 1);
            }
            if (level === 1) Object.preventExtensions(a);
            if (level === 2) Object.seal(a);
            if (level === 3) Object.freeze(a);
            let outcome = "ok";
            const value = kind === 0 ? 9 : kind === 1 ? true : "9";
            const contents = (array: typeof a): string => {
              let state = "";
              for (let i = 0; i < array.length; i++)
                state += !Object.hasOwn(array, i)
                  ? "h"
                  : array[i] === undefined
                    ? "u"
                    : kind === 1
                      ? Number(array[i])
                      : array[i];
              return state;
            };
            try {
              if (mode === 4) {
                const sorted = op === 0 ? a.sort() : a.toSorted();
                outcome += ":" + sorted.length + ":" + contents(sorted);
              } else if (mode === 3) {
                const prepend = op % 2 !== 0;
                const number = (n: number): number | boolean | string =>
                  kind === 0 ? n : kind === 1 ? Boolean(n % 2) : String(n);
                const args: typeof a =
                  op < 2 || (op >= 10 && op < 12)
                    ? []
                    : op < 4
                      ? [value]
                      : op < 6
                        ? [number(8), value]
                        : op < 8
                          ? // eslint-disable-next-line no-sparse-arrays -- Exercise a hole in spread input.
                            [value, undefined, , number(8)]
                          : op < 10
                            ? a
                            : op < 14
                              ? Array.from({ length: 65 }, (_, i) => number((i % 9) + 1))
                              : [undefined];
                outcome += ":" + (prepend ? a.unshift(...args) : a.push(...args));
              } else if (mode === 2) {
                const action = op < 12 ? op : op - 12;
                const first = kind === 0 ? 8 : kind === 1 ? false : "8";
                let removed: typeof a;
                switch (action) {
                  case 0:
                    removed = a.splice(0, 0);
                    break;
                  case 1:
                    removed = a.splice(0, 1);
                    break;
                  case 2:
                    removed = a.splice(1, 1);
                    break;
                  case 3:
                    removed = a.splice(-2, 1);
                    break;
                  case 4:
                    removed = a.splice(0, n);
                    break;
                  case 5:
                    removed = a.splice(1, Infinity);
                    break;
                  case 6:
                    removed = a.splice(1, 0, value);
                    break;
                  case 7:
                    removed = a.splice(1, 1, value);
                    break;
                  case 8:
                    removed = a.splice(1, 2, value);
                    break;
                  case 9:
                    removed = a.splice(0, 1, first, value);
                    break;
                  case 10:
                    removed = a.splice(n, 0, undefined);
                    break;
                  default:
                    removed = a.splice(0, n, ...a);
                    break;
                }
                if (op < 12) outcome += ":" + removed.length + ":" + contents(removed);
              } else if (mode === 1) {
                const removed = op === 0 ? a.pop() : a.shift();
                outcome +=
                  ":" + (removed === undefined ? "u" : kind === 1 ? Number(removed) : removed);
              } else
                switch (op) {
                  case 0:
                    a.reverse();
                    break;
                  case 1:
                    a.fill(value);
                    break;
                  case 2:
                    a.fill(value, 1, 1);
                    break;
                  case 3:
                    a.fill(undefined, 1, n - 1);
                    break;
                  case 4:
                    a.copyWithin(0, 0, n);
                    break;
                  case 5:
                    a.copyWithin(1, 0, n);
                    break;
                  case 6:
                    a.copyWithin(0, 1, n);
                    break;
                  case 7:
                    a.copyWithin(-2, 0, n - 1);
                    break;
                }
            } catch (e) {
              outcome = String(e);
            }
            lines.push([kind, n, pattern, level, op, outcome, a.length, contents(a)].join("|"));
          }
    }
  return lines.join("\n") + "\n";
}

test.each([0, 1, 2, 3, 4])("array mutation integrity matches Node (mode=%s)", async (mode) => {
  const argument = [
    "--integrity-range-oracle",
    "--integrity-removal-oracle",
    "--integrity-splice-oracle",
    "--integrity-extend-oracle",
    "--integrity-sort-oracle",
  ][mode]!;
  const { stdout, stderr } = await execFileAsync(bin, [argument], {
    maxBuffer: 4 * 1024 * 1024,
  });
  expect(stderr).toBe("");
  expect(stdout).toBe(mutationOracle(mode));
});
