import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { EXECUTABLE_RUNTIME_SOURCES } from "../../compiler/src/backend/native-toolchain.js";

const exec = promisify(execFile);

/* The dynamic readable.iterator options parser reads a property from an
 * untrusted object: its lookup must use the property's byte length and the
 * value obj_get yields is borrowed. The fixture builds the NUL-suffixed
 * property JSON can spell; a release of the borrowed value is a double free
 * at options teardown, which the sanitized run proves. */
test.skipIf(process.platform === "win32")(
  "dynamic readable.iterator options borrow their property value",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-stream-iterator-"));
    try {
      const bin = join(dir, "stream-iterator");
      await exec(
        "clang",
        [
          "-std=c11",
          "-O1",
          "-fsanitize=address",
          "-Wno-deprecated-declarations",
          ...(process.platform === "linux" ? ["-D_GNU_SOURCE"] : []),
          ...[
            "scr_stream_iterator.test.c",
            "scr_stream_iterator.c",
            "scr_stream.c",
            "scr_stream_ops.c",
            "scr_stream_defaults.c",
            "scr_symbol.c",
            "scr_events.c",
            "scr_events_emitter.c",
            "scr_async_dyn.c",
            "scr_assert.c",
            "scr_dyn_handle.c",
            "scr_readline.c",
            "scr_readline_tty.c",
            ...EXECUTABLE_RUNTIME_SOURCES,
          ].map((name) => join(import.meta.dirname, name)),
          ...(process.platform === "linux" ? ["-lm"] : []),
          "-o",
          bin,
        ],
        { maxBuffer: 64 << 20 },
      );
      const result = await exec(bin, [], {
        timeout: 60_000,
        env: {
          ...process.env,
          UBSAN_OPTIONS: "halt_on_error=1",
          ASAN_OPTIONS: "detect_leaks=0",
        },
      });
      expect(result.stdout).toBe("stream iterator options parse without a borrowed release\n");
      expect(result.stderr).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
