// Never-suspending async functions in a program that enters no
// AsyncLocalStorage store and reads no stacks: awaited from stackless and
// fiber bodies, called without an await, nested, throwing, and rejecting
// without a handler, against concurrent microtasks.
const log: string[] = [];

async function leaf(n: number): Promise<number> {
  log.push(`leaf ${n}`);
  return n + 1;
}
async function nestedLeaf(n: number): Promise<number> {
  const inner = leaf(n * 10);
  void inner.then((v) => log.push(`nestedLeaf inner ${v}`));
  log.push(`nestedLeaf ${n}`);
  return n;
}
async function thrower(n: number): Promise<number> {
  log.push(`thrower ${n}`);
  if (n > 0) throw new TypeError(`bad ${n}`);
  return n;
}
function ticker(name: string, turns: number): Promise<void> {
  let p = Promise.resolve();
  for (let i = 0; i < turns; i++) p = p.then(() => void log.push(`${name} tick ${i}`));
  return p;
}

async function stackless(): Promise<void> {
  const a = await leaf(1);
  const b = await leaf(a);
  try {
    await thrower(b);
  } catch (e) {
    log.push(`stackless caught ${(e as Error).name} ${(e as Error).message}`);
  }
  log.push(`stackless ${a + b}`);
}
async function* source(): AsyncGenerator<number, void, undefined> {
  yield 1;
  yield 2;
}
async function fibered(): Promise<void> {
  let s = 0;
  for await (const v of source()) s += await leaf(v);
  try {
    s += await thrower(5);
  } catch (e) {
    log.push(`fibered caught ${(e as Error).message}`);
  }
  log.push(`fibered ${s}`);
}
async function spawned(): Promise<void> {
  const p = leaf(7);
  const q = thrower(0);
  log.push("spawned before await");
  log.push(`spawned ${(await p) + (await q)}`);
}

process.on("unhandledRejection", (reason) => console.log(`unhandled ${(reason as Error).message}`));
async function main(): Promise<void> {
  void thrower(9);
  await Promise.all([ticker("t", 6), stackless(), fibered(), spawned(), nestedLeaf(3)]);
  for (const line of log) console.log(line);
}
void main();
