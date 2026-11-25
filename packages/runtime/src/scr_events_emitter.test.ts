import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { EXECUTABLE_RUNTIME_SOURCES } from "../../compiler/src/backend/native-toolchain.js";
import { buildCFixture } from "../test/build-c.js";

const exec = promisify(execFile);

test.skipIf(process.platform === "win32")(
  "errorMonitor can change the listeners of the current emit",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-emitter-monitor-"));
    try {
      const output = join(dir, "monitor");
      const darwin = process.platform === "darwin";
      await buildCFixture({
        output,
        flags: [
          "-std=c11",
          "-O1",
          "-pthread",
          "-Wno-deprecated-declarations",
          "-ffunction-sections",
          "-fdata-sections",
          ...(darwin ? [] : ["-D_GNU_SOURCE"]),
          ...(process.env["SCRIPTC_SAN"] === "1"
            ? ["-fsanitize=address,undefined", "-DSCR_RC_AUDIT"]
            : []),
        ],
        sources: [
          "scr_events_emitter.test.c",
          "scr_events_emitter.c",
          "scr_dyn_handle.c",
          ...EXECUTABLE_RUNTIME_SOURCES,
        ].map((file) => join(import.meta.dirname, file)),
        libraries: darwin ? ["-Wl,-dead_strip"] : ["-Wl,--gc-sections", "-lm"],
      });
      for (const mode of ["typed", "mixed", "dynamic", "value", "flex", "carried"]) {
        const { stdout, stderr } = await exec(output, [mode]);
        expect(stdout).toBe("monitor changes affect the same error event\n");
        expect(stderr).toBe("");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  240_000,
);
