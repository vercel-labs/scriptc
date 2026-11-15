import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { workerTargetPaths } from "./worker-target.js";
import { fallbackDtsPath, fallbackModulePath } from "./dts-paths.js";
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
  const program = host.createProgram(
    [entry, fallbackDtsPath(), fallbackModulePath("node:worker_threads")!],
    {
      noLib: true,
      types: [],
      module: ModuleKind.ESNext,
      moduleResolution: ModuleResolutionKind.Bundler,
    },
  );
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

test("worker discovery bounds a written binding's values", () => {
  // A written binding is not a dynamic root while its values are bounded:
  // the site selects on the runtime value and the residual arm throws
  // ERR_SCRIPTC_WORKER_ENTRY, so a later reassignment to an unknown
  // specifier cannot load the wrong file.
  expect(
    discover(`
    import { Worker } from "node:worker_threads";
    let filename = new URL("./facade.ts", import.meta.url);
    new Worker(filename);
  `),
  ).toEqual(["facade.ts"]);
});

test("worker discovery leaves a bounded value with no file to the run-time arm", () => {
  // A bound is a superset of what the site loads. A value whose file does
  // not exist gets no native arm, so it must not become a root either: the
  // missing root would fail a build whose other values run.
  expect(
    discover(`
    import { Worker } from "node:worker_threads";
    declare const flag: boolean;
    const name = flag ? "./facade.ts" : "./missing.ts";
    new Worker(new URL(name, import.meta.url));
    let absent = "/mutable.ts";
    new Worker(absent);
  `),
  ).toEqual(["facade.ts"]);
});

test("worker discovery rejects dynamic roots and shadowed globals or constructors", () => {
  expect(
    discover(`
    import { Worker } from "node:worker_threads";
    new Worker("./cwd-dependent.ts");
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

test("worker discovery folds a string method on the module's own URL", () => {
  // `import.meta.url` is a string: a method on it answers another string,
  // which names a file again inside `new URL(...)`. The root is that file,
  // not this module (the receiver's own URL), and a string that is still a
  // `file:` URL names no path for the constructor.
  expect(
    discover(`
    import { Worker } from "node:worker_threads";
    function entry(): URL {
      return new URL(import.meta.url.replace("main.ts", "facade.ts"));
    }
    new Worker(entry());
    new Worker(import.meta.url.replace("main.ts", "facade.ts"));
  `),
  ).toEqual(["facade.ts"]);
});
