// `promise.finally(callback)` over typed promises (void, a class instance, a Map, an async
// generator): a promise the callback returns is waited for before the settlement goes on, and a
// throw of the callback replaces it.
let tick = 0;
function spin(i: number): void { if (i < 10) Promise.resolve().then(() => { tick++; spin(i + 1); }); }
async function work(): Promise<void> { console.log("work"); }
function cleanup(): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(() => { console.log("cleaned up"); resolve(); }, 1); });
}
function quick(): Promise<void> { return Promise.resolve(); }
class Box { n: number; constructor(n: number) { this.n = n; } }
async function boxed(): Promise<Box> { return new Box(1); }
async function* gen(): AsyncGenerator<number> { yield 1; }
async function main(): Promise<void> {
  spin(0);
  work().finally(() => quick()).then(() => { console.log("void quick tick", tick); });
  await work().finally(() => cleanup());
  console.log("after void finally");
  const b = await boxed().finally(() => cleanup());
  console.log("after box finally", b.n);
  const m = await Promise.resolve(new Map<string, number>([["a", 1]])).finally(() => cleanup());
  console.log("after map finally", m.size);
  const g = await Promise.resolve(gen()).finally(() => cleanup());
  console.log("after generator finally", (await g.next()).value);
  await work().finally(() => { throw new Error("from finally"); }).catch((e) => { console.log("caught", (e as Error).message); });
  await Promise.reject(new Error("first")).finally(() => cleanup()).catch((e) => { console.log("kept", (e as Error).message); });
}
main();
