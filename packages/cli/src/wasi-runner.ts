#!/usr/bin/env node
/* The subprocess host for `scriptc run` on wasm32-wasi. Keeping the WASI
 * instance outside the CLI process preserves native run's exit isolation:
 * process.exit(), traps, and signals cannot take the compiler process down.
 */
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { WASI } from "node:wasi";
import { wasiGuestPath } from "@scriptc/compiler";
import { wasiEnvironment, wasiPreopens } from "./paths.js";

type WasiInstance = Parameters<WASI["start"]>[0];
declare const WebAssembly: {
  instantiate(
    bytes: Uint8Array,
    imports: ReturnType<WASI["getImportObject"]>,
  ): Promise<{ instance: WasiInstance }>;
};

const binary = process.argv[2];
if (binary === undefined) throw new Error("scriptc WASI runner needs a module path");
const cwd = process.cwd();
const hostTmp = tmpdir();

const wasi = new WASI({
  version: "preview1",
  args: [wasiGuestPath(binary, cwd, hostTmp) ?? binary],
  env: wasiEnvironment(process.env, cwd, hostTmp),
  // A native scriptc executable inherits access to the caller's filesystem.
  // WASI is capability-based, so expose the caller's working tree as `/`
  // and the platform's actual temporary directory as guest `/tmp`.
  preopens: wasiPreopens(cwd, hostTmp),
  returnOnExit: true,
});
const instantiated = await WebAssembly.instantiate(
  await readFile(binary),
  wasi.getImportObject(),
);
process.exitCode = wasi.start(instantiated.instance);
