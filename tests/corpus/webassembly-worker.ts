import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

// The codemode shape: the main thread compiles a module once and sends the
// WebAssembly.Module to a fresh Worker per job, through workerData and
// through postMessage; each worker instantiates it with its own imports,
// runs it, and reports back. Traps in a worker (out-of-bounds memory and
// stack exhaustion, both caught by the per-thread fault handling) stay in
// that worker. The module text is tests/wasm-spec/corpus/api.wat.
const bytes = Buffer.from("AGFzbQEAAAABLwlgAX8Bf2ACf38Bf2ABfwBgAABgAAF/YAJ+fgF+YAJ/fwJ/f2ABfQF9YAN/f38AAi0EA2VudgNsb2cAAgNlbnYEZmFpbAAAA2VudgRiYXNlA38AA2VudgNiaWcDfgADEhEAAAMBAQQFBgcAAAQAAAAICAQFAXABAggFBAEBAQQGFwN/AUEAC3wARAAAAAAAAApAC34AIwELB5kBEwZtZW1vcnkCAAV0YWJsZQEAB2NvdW50ZXIDAgJwaQMDBGJpZzIDBANhZGQABQVhcHBseQAGBGJ1bXAABwVtdWw2NAAIBmRpdm1vZAAJBm5hcnJvdwAKBnN0cmxlbgALBGdyb3cADAVwYWdlcwANCGNhbGxGYWlsAA4EdHJhcAAPB3JlY3Vyc2UAEARmaWxsABEEY29weQASCAEECQgBAEEACwICAwqHAhEHACAAQQJsCwcAIAAgAGwLBgAjABAACwcAIAAgAWoLCQAgASAAEQAACwsAIwJBAWokAiMCCwcAIAAgAX4LDAAgACABbSAAIAFvCwQAIAALIAEBfwJAA0AgACABai0AAEUNASABQQFqIQEMAAsLIAELBgAgAEAACwQAPwALCQAgABABQQFqC1kAAkACQAJAAkACQAJAAkAgAA4GAAECAwQFBgsAC0EBQQBuDwtB/////wcoAgAPC0EBQQJBABEBAA8LQQFBBxEAAA8LRAAAAAAAAPh/qg8LQYCAgIB4QX9tCwwAIABBAWoQEEEBagsLACAAIAEgAvwLAAsMACAAIAEgAvwKAAALCw4BAEEQCwhzY3JpcHRjAA==", "base64");

interface Job {
  module: WebAssembly.Module;
  input: number;
}

function run(module: WebAssembly.Module, input: number): string {
  const seen: number[] = [];
  const imports = {
    env: {
      log: (v: number): void => {
        seen.push(v);
      },
      fail: (v: number): number => v * 2,
      base: input,
      big: BigInt(input),
    },
  } as unknown as WebAssembly.Imports;
  const instance = new WebAssembly.Instance(module, imports);
  const exports = instance.exports;
  const apply = exports.apply as (fn: number, v: number) => number;
  const callFail = exports.callFail as (v: number) => number;
  const trap = exports.trap as (kind: number) => number;
  const recurse = exports.recurse as (v: number) => number;
  const traps: string[] = [];
  for (const attempt of [() => trap(2), () => recurse(0), () => trap(1)]) {
    try {
      attempt();
    } catch (e) {
      traps.push(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }
  }
  return `job ${input}: start ${seen.join(",")} apply ${apply(1, input + 3)} callFail ${callFail(input)} traps ${traps.join(" | ")}`;
}

if (isMainThread) {
  const module = await WebAssembly.compile(bytes);
  console.log(run(module, 0));
  for (let input = 1; input <= 3; input++) {
    const line = await new Promise<string>((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url), { workerData: { module, input } satisfies Job });
      worker.once("message", (message: string) => resolve(message));
      worker.once("error", reject);
    });
    console.log(line);
  }
  const worker = new Worker(new URL(import.meta.url), { workerData: null });
  const reply = new Promise<string>((resolve) => worker.once("message", (message: string) => resolve(message)));
  worker.postMessage({ module, input: 9 } satisfies Job);
  console.log(await reply);
  console.log("main still works:", run(module, 4).slice(0, 18));
} else if (workerData !== null) {
  const job = workerData as Job;
  parentPort!.postMessage(`${job.module instanceof WebAssembly.Module} ${run(job.module, job.input)}`);
} else {
  parentPort!.once("message", (job: Job) => {
    parentPort!.postMessage(run(job.module, job.input));
  });
}
