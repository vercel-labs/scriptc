// A program that starts a worker compiles every closure global as thread-local
// state, and a generic declaration held as a value at more than one signature
// keeps one identity root. Each thread's global is then its own copy, so every
// instance must adopt the root the thread actually holds: `===`, Map keys and
// searches see one function on the main thread and in every worker.
import { Worker, isMainThread, parentPort } from "node:worker_threads";

interface Box<T> {
  v: T;
}

function unbox<T>(box: Box<T>): T {
  return box.v;
}

type NumFn = (box: Box<number>) => number;
type AnyFn = (box: Box<number>) => number | string;

function report(label: string): string {
  const viaUnion: AnyFn | undefined = unbox;
  const pinned: NumFn = unbox;
  const anyPin: (box: Box<number>) => unknown = unbox;
  const exported = unbox<number>;
  const erased = unbox<any>;
  const registry = new Map<NumFn, string>();
  registry.set(pinned, "pinned");
  registry.set(unbox, "unbox");
  const list: NumFn[] = [pinned];
  const ua: unknown = pinned;
  const ub: unknown = unbox;
  return [
    label,
    `union=${viaUnion === unbox}`,
    `pinned=${pinned === unbox}`,
    `any=${anyPin === pinned}`,
    `inst=${exported === erased}`,
    `unknown=${ua === ub}`,
    `keys=${registry.size}`,
    `at=${registry.get(unbox)}`,
    `index=${list.indexOf(unbox)}`,
    `call=${unbox({ v: 2 })}`,
  ].join(" ");
}

if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url));
  worker.on("message", (message: unknown) => {
    console.log(report("main"));
    console.log(String(message));
  });
} else {
  parentPort!.postMessage(report("worker"));
}
