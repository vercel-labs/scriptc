// A stackless async body awaiting a stackless callee that suspends:
// results of each kind, callees that finish without suspending, nested
// chains, throws before and after the first suspension, and an uncaught
// rejection, against a ticker that logs every microtask turn.
interface Point {
  x: number;
  y: number;
}
const log: string[] = [];

async function slowNumber(n: number, turns: number): Promise<number> {
  for (let i = 0; i < turns; i++) await null;
  log.push(`slowNumber ${n} done`);
  return n * 2;
}
async function maybeSuspend(n: number): Promise<number> {
  if (n > 0) await null;
  log.push(`maybeSuspend ${n}`);
  return n + 100;
}
async function slowFlag(n: number): Promise<boolean> {
  await null;
  return n % 2 === 0;
}
async function slowLabel(s: string): Promise<string> {
  await null;
  return `<${s}>`;
}
async function slowPoint(n: number): Promise<Point> {
  await null;
  return { x: n, y: n * n };
}
async function slowVoid(tag: string): Promise<void> {
  await null;
  log.push(`slowVoid ${tag}`);
}
async function throwsEarly(n: number): Promise<number> {
  if (n > 0) throw new RangeError(`early ${n}`);
  await null;
  return n;
}
async function throwsLate(n: number): Promise<number> {
  await null;
  await null;
  throw new TypeError(`late ${n}`);
}
async function chain(depth: number): Promise<number> {
  await null;
  if (depth === 0) return 1;
  return 1 + (await chain(depth - 1));
}
function ticker(name: string, turns: number): Promise<void> {
  let p = Promise.resolve();
  for (let i = 0; i < turns; i++) p = p.then(() => void log.push(`${name} tick ${i}`));
  return p;
}

async function values(): Promise<void> {
  const a = await slowNumber(1, 2);
  const b = await maybeSuspend(0);
  const c = await maybeSuspend(1);
  const f = await slowFlag(4);
  const s = await slowLabel("x");
  const p = await slowPoint(3);
  await slowVoid("v");
  log.push(`values ${a} ${b} ${c} ${f} ${s} ${p.x + p.y}`);
}
async function errors(): Promise<void> {
  try {
    await throwsEarly(1);
  } catch (e) {
    log.push(`errors caught ${(e as Error).name} ${(e as Error).message}`);
  }
  try {
    await throwsLate(2);
  } catch (e) {
    log.push(`errors caught ${(e as Error).name} ${(e as Error).message}`);
  }
  log.push(`errors ok ${await throwsEarly(0)}`);
}
async function nested(): Promise<void> {
  log.push(`nested ${await chain(4)}`);
}
async function uncaught(): Promise<void> {
  await slowNumber(9, 1);
  await throwsLate(9);
  log.push("uncaught resolved");
}

process.on("unhandledRejection", (reason) => console.log(`unhandled ${(reason as Error).message}`));
async function main(): Promise<void> {
  void uncaught();
  await Promise.all([ticker("t", 10), values(), ticker("u", 3), errors(), nested()]);
  for (const line of log) console.log(line);
}
void main();
