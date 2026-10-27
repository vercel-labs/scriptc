// An async function's AsyncLocalStorage store across `for await` over an
// async generator: the consumer keeps its store after each resumption of
// the generator, whether it came from run(), from enterWith before the
// loop, or from enterWith after an earlier await.
import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage<string>();
const current = (): string => store.getStore() ?? "none";

async function* numbers(n: number): AsyncGenerator<number, void, undefined> {
  for (let i = 0; i < n; i++) {
    await null;
    yield i;
  }
}

async function consume(label: string): Promise<void> {
  let sum = 0;
  for await (const v of numbers(3)) {
    sum += v;
    console.log(`${label} step ${v}: ${current()}`);
  }
  console.log(`${label} after the loop (${sum}): ${current()}`);
}

async function entered(): Promise<void> {
  await null;
  store.enterWith("entered");
  await consume("entered");
}

async function main(): Promise<void> {
  await store.run("run", () => consume("run"));
  await entered();
  console.log(`main: ${current()}`);
}
void main();
