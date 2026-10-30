import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const exec = promisify(execFile);

test("layouts stay within the layout and key-byte budgets, and dynamic-tier absent reads are cached", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "scriptc-js-object-"));
  const src = import.meta.dirname;
  const binary = join(scratch, "js-object");
  try {
    await exec("clang", [
      "-std=c11",
      "-O1",
      "-Wall",
      "-Wextra",
      "-fsanitize=address,undefined",
      "-DSCR_JS_TIER",
      "-I",
      src,
      "-o",
      binary,
      ...[
        "scr_js_object.test.c",
        "scr_js_object.c",
        "scr_json.c",
        "scr_string.c",
        "scr_array.c",
        "scr_arena.c",
        "scr_map.c",
        "scr_exception.c",
        "scr_error.c",
        "scr_number.c",
        "scr_console.c",
        "scr_closure.c",
        "scr_object.c",
        "scr_union.c",
        "scr_cycle.c",
        "scr_alloc.c",
        "scr_lib.c",
        "scr_hash.c",
        "scr_bytes.c",
        "scr_shared.c",
        "scr_bigint.c",
        "scr_url.c",
        "scr_url_params.c",
        "scr_path.c",
      ].map((file) => join(src, file)),
      ...(process.platform === "linux" ? ["-D_GNU_SOURCE", "-lm"] : []),
    ]);
    for (const [args, stdout] of [
      [[], "shape budget checks passed\n"],
      [["key-bytes"], "shape budget checks passed\n"],
      [["absent"], "absent read checks passed\n"],
    ] as const) {
      const result = await exec(binary, [...args], {
        env: {
          ...process.env,
          ASAN_OPTIONS: "detect_leaks=0:halt_on_error=1",
          UBSAN_OPTIONS: "halt_on_error=1",
        },
      });
      expect(result.stdout).toBe(stdout);
      expect(result.stderr).toBe("");
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
