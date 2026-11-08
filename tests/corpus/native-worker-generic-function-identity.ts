// One generic declaration, several compiled instances, in a program that
// starts a worker thread. JavaScript has one function object per thread for
// the declaration, however it is instantiated or held: `===` (typed, through
// a union and through `unknown`), `Object.is`, Map and Set keys, searches,
// a value that went through a callback slot, `name` and `length` all see one
// function. Each thread evaluates the module again, so the worker has its
// own function objects, and a function cannot be posted to another thread.
import { Worker, isMainThread, parentPort } from "node:worker_threads";

interface Box<T> {
  v: T;
}

function unbox<T>(box: Box<T>): T {
  return box.v;
}

function first<A, B>(a: A, _b: B): A {
  return a;
}

type NumFn = (box: Box<number>) => number;
type StrFn = (box: Box<string>) => string;
type AnyFn = (box: Box<number>) => number | string;

let current: AnyFn | undefined;
function install(f: AnyFn): void {
  current = f;
}

let seen: NumFn | undefined;
function relay(f: NumFn, sink: (g: NumFn) => void): void {
  sink(f);
}

function check(label: string): string[] {
  const out: string[] = [];
  // Instantiation expressions of one declaration.
  const n = unbox<number>;
  const s = unbox<string>;
  const un: unknown = n;
  const us: unknown = s;
  out.push(`${label} instantiations: ${un === us} ${n({ v: 1 })} ${s({ v: "s" })}`);
  // A union operand: no single signature to pin the declaration to.
  install(unbox);
  out.push(`${label} union operand: ${current === unbox} ${current !== unbox}`);
  // Two pins at different signatures.
  const pinned: NumFn = unbox;
  const anyPin: (box: Box<number>) => unknown = unbox;
  out.push(`${label} pins: ${pinned === unbox} ${pinned === anyPin}`);
  // Through `unknown`.
  const ua: unknown = pinned;
  const ub: unknown = unbox;
  out.push(`${label} unknown: ${ua === ub} ${ua !== ub} ${Object.is(pinned, unbox)} ${Object.is(ua, us)}`);
  // Map and Set keys.
  const registry = new Map<NumFn, string>();
  registry.set(pinned, "pinned");
  registry.set(unbox, "unbox");
  const set = new Set<unknown>([ua, ub, us, un]);
  out.push(`${label} keys: ${registry.size} ${registry.get(pinned)} ${registry.has(unbox)} ${set.size}`);
  // Searches.
  const list: NumFn[] = [pinned];
  out.push(`${label} searches: ${list.indexOf(unbox)} ${list.includes(unbox)} ${list.lastIndexOf(unbox)}`);
  // After passing through a callback slot.
  relay(unbox, (g) => {
    seen = g;
  });
  const useen: unknown = seen;
  out.push(`${label} callback slot: ${seen === unbox} ${seen === pinned} ${useen === us}`);
  // `name` and `length`, whichever instance is asked.
  const f1: (a: number, b: string) => number = first;
  const f2: (a: string, b: number) => string = first;
  const uf1: unknown = f1;
  const uf2: unknown = f2;
  out.push(
    `${label} name/length: ${pinned.name} ${pinned.length} ${s.name} ${s.length} ${f1.name} ${f1.length} ${f2.name} ${f2.length} ${uf1 === uf2}`,
  );
  // Distinct functions stay distinct.
  const other: NumFn = (box) => box.v;
  out.push(`${label} control: ${pinned === other} ${registry.has(other)}`);
  return out;
}

if (isMainThread) {
  for (const line of check("main")) console.log(line);
  const worker = new Worker(new URL(import.meta.url));
  worker.on("message", (lines: string[]) => {
    for (const line of lines) console.log(line);
  });
  worker.on("exit", (code) => {
    console.log("exit", code);
  });
  // Functions stay on their thread.
  const erased: unknown = unbox;
  try {
    worker.postMessage(erased);
    console.log("posted");
  } catch (error) {
    console.log((error as Error).name);
  }
  worker.postMessage("check");
} else {
  parentPort!.on("message", (message: unknown) => {
    if (message !== "check") return;
    parentPort!.postMessage(check("worker"));
    parentPort!.close();
  });
}
