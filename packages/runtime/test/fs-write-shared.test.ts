import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildCFixture } from "./build-c.js";

const execFileAsync = promisify(execFile);
const testDir = import.meta.dirname;
const srcDir = join(testDir, "../src");
const bin = join(testDir, "build", "test_fs_write_shared");
let scratch: string;

// A shared payload reaches write() as a local snapshot, the rule
// scr_fs_write_file_open_bytes follows: the fixture wraps write() and fails
// when the pointer it receives is the SharedArrayBuffer storage. The
// options-record byte write takes the same path, and `--wrap` is the GNU
// link option that makes the pointer visible.
const SOURCES = [
  "scr_number.c",
  "scr_bigint.c",
  "scr_string.c",
  "scr_array.c",
  "scr_arena.c",
  "scr_bytes.c",
  "scr_shared.c",
  "scr_bytes_io.c",
  "scr_fs_cp.c",
  "scr_fs_flags.c",
  "scr_map.c",
  "scr_closure.c",
  "scr_ffi.c",
  "scr_object.c",
  "scr_union.c",
  "scr_exception.c",
  "scr_error.c",
  "scr_console.c",
  "scr_lib.c",
  "scr_hash.c",
  "scr_url.c",
  "scr_url_params.c",
  "scr_path.c",
  "scr_json.c",
  "scr_async.c",
  "scr_child.c",
  "scr_cycle.c",
  "scr_alloc.c",
  "scr_context.c",
].map((f) => join(srcDir, f));

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "scriptc-fs-write-shared-"));
  await mkdir(join(testDir, "build"), { recursive: true });
  await buildCFixture({
    output: bin,
    sources: [join(testDir, "test_fs_write_shared.c"), ...SOURCES],
    flags: [
      "-std=c11",
      "-O1",
      "-Wall",
      "-Wextra",
      "-D_GNU_SOURCE",
      "-DSCR_WORKERS",
      "-DSCR_FS_FLAGS",
      "-pthread",
      "-I",
      srcDir,
      "-Wno-deprecated-declarations",
      "-Wl,--wrap=write",
    ],
    libraries: ["-lm", "-lpthread"],
  });
});

afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

test.runIf(process.platform === "linux")(
  "the options-record byte write snapshots shared payloads",
  async () => {
    const { stdout } = await execFileAsync(bin, [scratch]);
    expect(stdout.trim()).toBe("shared options write checks passed");
  },
);
