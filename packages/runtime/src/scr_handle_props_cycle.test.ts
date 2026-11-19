import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const exec = promisify(execFile);

test.skipIf(process.platform === "win32")(
  "handle property tables are traced with their handle, and the guard is linear",
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), "scriptc-handle-props-"));
    const src = import.meta.dirname;
    const binary = join(scratch, "handle-props");
    try {
      await exec("clang", [
        "-std=c11",
        "-O1",
        "-Wall",
        "-Wextra",
        "-fsanitize=address,undefined",
        // The seen-set probe counter and the collector's test entry points.
        "-DSCR_CYC_TESTING",
        // The object model owns the handle-props hooks (scr_json.c).
        "-DSCR_JS_OBJECT_MODEL",
        "-ffunction-sections",
        "-fdata-sections",
        "-I",
        src,
        "-o",
        binary,
        // The stub in the test stands in for the dyn-invoke unit, which is
        // linked only by the functions this test does not reach; the
        // section flags drop those functions from the link.
        ...(process.platform === "linux" ? ["-D_GNU_SOURCE"] : []),
        process.platform === "darwin" ? "-Wl,-dead_strip" : "-Wl,--gc-sections",
        ...[
          "scr_handle_props_cycle.test.c",
          "scr_dyn_handle_props.c",
          "scr_json.c",
          "scr_record_source_get.c",
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
        ...(process.platform === "linux" ? ["-lm"] : []),
        "-pthread",
      ]);
      const result = await exec(binary, []);
      expect(result.stdout).toBe("handle property ownership and guard width ok\n");
      expect(result.stderr).toBe("");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
);
