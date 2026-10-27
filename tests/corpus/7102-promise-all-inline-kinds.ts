// `await Promise.all([...])` of never-suspending async calls with number,
// boolean, string and record results, inside loops and larger expressions,
// and an uncaught rejection.
interface Point {
  x: number;
  y: number;
}
const log: string[] = [];
async function flag(n: number): Promise<boolean> {
  log.push(`flag ${n}`);
  return n % 2 === 0;
}
async function point(n: number): Promise<Point> {
  log.push(`point ${n}`);
  return { x: n, y: n * n };
}
async function count(n: number): Promise<number> {
  if (n < 0) throw new RangeError(`negative ${n}`);
  return n + 1;
}
function ticker(name: string, turns: number): Promise<void> {
  let p = Promise.resolve();
  for (let i = 0; i < turns; i++) p = p.then(() => void log.push(`${name} tick ${i}`));
  return p;
}
async function flags(): Promise<void> {
  const r: boolean[] = await Promise.all([flag(1), flag(2)]);
  log.push(`flags ${r.join(",")}`);
}
async function points(): Promise<void> {
  const ps = [point(1), point(2), point(3)];
  const r = await Promise.all(ps);
  let sum = 0;
  for (const p of r) sum += p.x + p.y;
  log.push(`points ${sum}`);
}
async function loop(): Promise<void> {
  let total = 0;
  for (let i = 0; i < 3; i++) {
    const ps = [count(i), count(i * 2)];
    const r = await Promise.all(ps);
    total += r[0]! + r[1]!;
    log.push(`loop ${i} ${total}`);
  }
}
function sumOf(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}
async function nested(): Promise<void> {
  const total = 100 + sumOf(await Promise.all([count(4), count(5)]));
  log.push(`nested ${total}`);
}
async function uncaught(): Promise<void> {
  const ps = [count(1), count(-2), count(-3)];
  const r = await Promise.all(ps);
  log.push(`uncaught resolved ${r.length}`);
}
process.on("unhandledRejection", (reason) => {
  const e = reason as Error;
  console.log(`unhandled ${e.name} ${e.message}`);
});
async function main(): Promise<void> {
  void uncaught();
  await Promise.all([ticker("t", 6), flags(), points(), loop(), nested()]);
  for (const line of log) console.log(line);
}
void main();
