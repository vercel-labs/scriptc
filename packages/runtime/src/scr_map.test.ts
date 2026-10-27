import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const exec = promisify(execFile);

test("number-key maps keep Map semantics across linear, direct and hashed indexes", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "scriptc-map-"));
  const src = import.meta.dirname;
  const binary = join(scratch, "map");
  try {
    await exec("clang", [
      "-std=c11",
      "-O1",
      "-Wall",
      "-Wextra",
      "-fsanitize=address,undefined",
      "-I",
      src,
      "-o",
      binary,
      ...[
        "scr_map.test.c",
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
    const result = await exec(binary, [], {
      env: {
        ...process.env,
        ASAN_OPTIONS: "detect_leaks=0:halt_on_error=1",
        UBSAN_OPTIONS: "halt_on_error=1",
      },
    });
    expect(result.stdout).toBe("number-key maps passed\n");
    expect(result.stderr).toBe("");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}, 120_000);
