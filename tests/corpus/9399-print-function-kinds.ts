// A function's call kind is part of how Node prints it: an async function
// is [AsyncFunction: name], a generator [GeneratorFunction: name], an async
// generator [AsyncGeneratorFunction: name], whatever slot it is read through.
import { inspect } from "node:util";

type Callback = () => unknown;

async function load(): Promise<string> {
  return "loaded";
}
function* count(): Generator<number> {
  yield 1;
}
async function* stream(): AsyncGenerator<number> {
  yield 1;
}
function plain(): number {
  return 1;
}
const later = async (): Promise<void> => {};
function makeAsync(): Callback {
  return async () => {};
}

function show(callback: Callback): void {
  console.log(callback);
  console.log(inspect(callback));
}
show(load);
show(count);
show(stream);
show(plain);
show(later);
show(makeAsync());

function held(value: string | Callback | [Callback]): void {
  console.log(value);
}
held("text");
held(load);
held([count]);
held([stream]);

const steps: { name: string; run: Callback }[] = [
  { name: "a", run: load },
  { name: "b", run: count },
  { name: "c", run: plain },
];
console.log(steps);

// Through an untyped value as well.
const untyped: unknown = { load, count, stream, plain };
console.log(untyped);
