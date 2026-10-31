import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";
import { balancedShardSelect } from "./shard.js";

const hasZig = spawnSync("zig", ["version"], { stdio: "ignore" }).status === 0;
const requestedMode = process.env["SCRIPTC_LLVM_TEST_MODE"];
if (requestedMode !== undefined && requestedMode !== "release" && requestedMode !== "dev") {
  throw new Error("SCRIPTC_LLVM_TEST_MODE must be release or dev when set");
}
const wasiRunner = `
const {readFileSync} = require('node:fs');
const {WASI} = require('node:wasi');
const path = process.argv[1];
const wasi = new WASI({version:'preview1', args:[path], returnOnExit:true});
const module = new WebAssembly.Module(readFileSync(path));
const instance = new WebAssembly.Instance(module, wasi.getImportObject());
process.exitCode = wasi.start(instance);
`;

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000 });
  if (result.error) throw result.error;
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
    signal: result.signal,
  };
}

// Relative scheduling estimates spread the large TSL imports and loaders
// across workers; every target/fixture pair remains in the complete gate.
const cases = balancedShardSelect(
  [
    "math",
    "spatial",
    "attributes",
    "geometry",
    "scene",
    "materials",
    "mesh",
    "raycast-mesh",
    "raycast-camera",
    "raycast-lines-points",
    "buffers-animation",
    "collision",
    "package-imports",
    "curves",
    "textures",
    "math-extended",
    "procedural-geometry",
    "render-data",
    "mesh-workflows",
    "animation",
    "loaders",
    "gltf",
    "nodes",
  ].flatMap((fixture) => ["native", "wasm32-wasi"].map((target) => ({ fixture, target }))),
  ({ fixture, target }) => `three:${fixture}:${target}`,
  ({ fixture }) => (fixture === "nodes" ? 8 : fixture === "loaders" || fixture === "gltf" ? 4 : 1),
);
test.for(cases)(
  "published three.js $fixture runs statically through LLVM on $target",
  { timeout: 1_200_000 },
  async ({ fixture, target }, context) => {
    const entry = join(import.meta.dirname, `../fixtures/three/${fixture}.mjs`);
    if (target === "wasm32-wasi" && !hasZig) context.skip();
    // CI's Linux sanitized lane builds this one in its own job
    // (scripts/ci-test-plan.mjs).
    if (
      fixture === "nodes" &&
      target === "native" &&
      process.env["SCRIPTC_SAN"] === "1" &&
      process.env["SCRIPTC_THREE_SANITIZED_NODES_JOB"] === "1"
    )
      context.skip();
    const dir = await mkdtemp("/tmp/scriptc-three-");
    const previousTarget = process.env["SCRIPTC_TARGET"];
    const previousCc = process.env["SCRIPTC_CC"];
    const wasm = target === "wasm32-wasi";
    const sanitize = !wasm && process.env["SCRIPTC_SAN"] === "1";
    try {
      if (wasm) {
        process.env["SCRIPTC_TARGET"] = target;
        process.env["SCRIPTC_CC"] = "zigcc";
      }
      const result = await compile(entry, {
        outDir: dir,
        outPath: join(dir, wasm ? `${fixture}.wasm` : fixture),
        backend: "llvm",
        npmStatic: ["three"],
        optimization: sanitize ? "dev" : (requestedMode ?? "release"),
        sanitize,
      });
      if (!result.ok)
        throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      expect(result.backend).toBe("llvm");
      if (wasm)
        expect([...(await readFile(result.binaryPath)).subarray(0, 4)]).toEqual([0, 97, 115, 109]);
      const reference = run(process.execPath, ["--no-warnings", entry]);
      expect(reference.status).toBe(0);
      const actual = wasm
        ? run(process.execPath, ["--no-warnings", "-e", wasiRunner, result.binaryPath])
        : run(result.binaryPath, []);
      if (sanitize)
        actual.stderr = actual.stderr
          .split("\n")
          .filter(
            (line) =>
              !/^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext/.test(line),
          )
          .join("\n");
      expect(actual).toEqual(reference);
    } finally {
      if (previousTarget === undefined) delete process.env["SCRIPTC_TARGET"];
      else process.env["SCRIPTC_TARGET"] = previousTarget;
      if (previousCc === undefined) delete process.env["SCRIPTC_CC"];
      else process.env["SCRIPTC_CC"] = previousCc;
      await rm(dir, { recursive: true, force: true });
    }
  },
);
