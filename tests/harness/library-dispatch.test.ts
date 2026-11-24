// @requires-wasi-runtime-pack: needs @scriptc/runtime-wasm32-wasi/runtime-pack.json.
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WASI } from "node:wasi";
import { expect, test } from "vitest";
import { compileLibrary } from "@scriptc/compiler";

const fixture = join(import.meta.dirname, "../library-mode/wasm/dispatch.mjs");
const modes = ["native", "sanitized", "wasm-dev"] as const;

test.for(modes)(
  "synchronous checked dispatch in a %s library matches Node",
  async (mode, context) => {
    if (
      mode === "wasm-dev"
        ? spawnSync("zig", ["version"]).status !== 0
        : process.platform !== "darwin" && process.platform !== "linux"
    )
      context.skip();
    const directory = await mkdtemp("/tmp/scriptc-library-dispatch-");
    const oldTarget = process.env["SCRIPTC_TARGET"];
    try {
      if (mode === "wasm-dev") process.env["SCRIPTC_TARGET"] = "wasm32-wasi";
      else delete process.env["SCRIPTC_TARGET"];
      const profilePath = join(directory, "profile.json");
      await writeFile(
        profilePath,
        JSON.stringify({
          profile_format: 1,
          name: "sync-dispatch",
          entry: fixture,
          emission: "llvm",
          optimization: mode === "wasm-dev" ? "dev" : "release",
          abi: { prefix: "app_", init_symbol: "app_init", sink_register_symbol: "app_sink" },
          exports: [{ export: "dispatch", symbol: "app_dispatch", params: [], returns: "f64" }],
        }),
      );
      const result = await compileLibrary({
        profilePath,
        outDir: directory,
        sanitize: mode === "sanitized",
      });
      if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
      const reference = spawnSync(
        process.execPath,
        [
          "--no-warnings",
          "--input-type=module",
          "-e",
          `import {dispatch} from ${JSON.stringify(fixture)}; console.log(dispatch());`,
        ],
        { encoding: "utf8" },
      );
      let actual: { stdout: string; stderr: string; status: number | null };
      if (mode === "wasm-dev") {
        const wasi = new WASI({ version: "preview1" });
        const instance = new WebAssembly.Instance(
          new WebAssembly.Module(await readFile(result.archivePath)),
          {
            ...wasi.getImportObject(),
            scriptc: {
              panic() {
                throw new Error("unexpected panic");
              },
            },
          },
        );
        wasi.initialize(instance);
        (instance.exports.app_init as Function)();
        actual = {
          stdout: `${(instance.exports.app_dispatch as Function)()}\n`,
          stderr: "",
          status: 0,
        };
      } else {
        const probe = join(directory, "probe.c"),
          binary = join(directory, "probe");
        await writeFile(
          probe,
          '#include <stdio.h>\nvoid app_init(void); double app_dispatch(void);\nint main(void) { app_init(); printf("%.0f\\n", app_dispatch()); app_init(); return 0; }\n',
        );
        const link = spawnSync(
          "clang",
          [
            probe,
            result.archivePath,
            "-lm",
            ...(mode === "sanitized" ? ["-fsanitize=address"] : []),
            "-o",
            binary,
          ],
          { encoding: "utf8" },
        );
        expect(link.status, link.stderr).toBe(0);
        actual = spawnSync(binary, [], { encoding: "utf8" });
      }
      expect({ stdout: actual.stdout, stderr: actual.stderr, status: actual.status }).toEqual({
        stdout: reference.stdout,
        stderr: reference.stderr,
        status: reference.status,
      });
    } finally {
      if (oldTarget === undefined) delete process.env["SCRIPTC_TARGET"];
      else process.env["SCRIPTC_TARGET"] = oldTarget;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
