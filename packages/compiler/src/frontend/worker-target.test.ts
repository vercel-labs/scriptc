import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { workerTargetPaths } from "./worker-target.js";
import { fallbackDtsPath } from "./dts-paths.js";
import { Ts7Host } from "./ts7/program-host.js";
import { Ts7Api } from "./ts7/rpc-api.js";
import { ModuleKind, ModuleResolutionKind } from "./ts7/enums.js";

function discover(source: string): string[] {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-worker-discovery-"));
  const entry = join(directory, "main.ts");
  writeFileSync(entry, source);
  writeFileSync(
    join(directory, "facade.ts"),
    'export { Worker as Task } from "node:worker_threads";',
  );
  const host = new Ts7Host((options) => new Ts7Api(options), { cwd: directory });
  const program = host.createProgram([entry, fallbackDtsPath()], {
    noLib: true,
    types: [],
    module: ModuleKind.ESNext,
    moduleResolution: ModuleResolutionKind.Bundler,
  });
  try {
    return workerTargetPaths(program, [program.getSourceFile(entry)!]).map((file) =>
      file.replace(directory + "/", ""),
    );
  } finally {
    program.dispose();
    host.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("worker discovery preserves imports, facades, CommonJS bindings and distinct roots", () => {
  expect(
    discover(`
    import { Worker as Start } from "node:worker_threads";
    import * as threads from "worker_threads";
    import workers from "node:worker_threads";
    import { Task } from "./facade.js";
    const { Worker: Required } = require("node:worker_threads");
    const module = require("worker_threads");
    const Constructor = module.Worker;
    new Start(new URL("./one.ts", import.meta.url));
    new threads.Worker(new URL("./two.ts", import.meta.url));
    new workers.Worker(new URL("./three.ts", import.meta.url));
    new Task(new URL("./four.ts", import.meta.url));
    new Required(__filename);
    new Constructor(new URL(import.meta.url));
    new (require("worker_threads").Worker)("/absolute/worker.ts");
    new Start(new URL("./one.ts", import.meta.url));
  `),
  ).toEqual(["one.ts", "two.ts", "three.ts", "four.ts", "main.ts", "/absolute/worker.ts"]);
});

test("worker discovery rejects dynamic roots and shadowed globals or constructors", () => {
  expect(
    discover(`
    import { Worker } from "node:worker_threads";
    new Worker("./cwd-dependent.ts");
    let filename = "/mutable.ts";
    new Worker(filename);
    function local(Worker: any) { new Worker("/local.ts"); }
    function loader(require: any) {
      const { Worker: Local } = require("worker_threads");
      new Local("/shadowed.ts");
    }
    function path(__filename: string) { new Worker(__filename); }
    function shadowURL(URL: any) { new Worker(new URL("/wrong.ts")); }
    let { Worker: Mutable } = require("worker_threads");
    new Mutable("/mutable-constructor.ts");
    let namespace = require("worker_threads");
    new namespace.Worker("/mutable-namespace.ts");
    const unrelated = { Worker: class {} };
    new unrelated.Worker("/unrelated.ts");
  `),
  ).toEqual([]);
});
