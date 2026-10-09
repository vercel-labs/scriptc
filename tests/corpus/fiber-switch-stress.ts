// Many concurrent fibers with deep, float-heavy frames across suspensions:
// each switch must preserve every callee-saved register (integer and
// floating point) and the stack, and finished fibers recycle their stacks.
// Generators interleave their own switches with the async ones.
function* walk(n: number): Generator<number> {
  let acc = 0.5;
  for (let i = 0; i < n; i++) {
    acc = acc * 1.25 + i / 3;
    yield acc;
  }
}
function mix(a: number, b: number, c: number, d: number): number {
  return (a * 1.5 + b / 2.25 - c * 0.75 + d) % 1000003;
}
async function worker(id: number, rounds: number, depth: number): Promise<number> {
  const x0 = id * 0.1;
  const x1 = id * 1.7;
  const x2 = id / 3;
  const x3 = Math.sqrt(id + 1);
  let total = 0;
  for (let r = 0; r < rounds; r++) {
    const before = mix(x0, x1, x2, x3);
    if (depth > 0 && r % 3 === 0) total += await worker(id * 7 + r, 2, depth - 1);
    else await null;
    const after = mix(x0, x1, x2, x3);
    if (before !== after) throw new Error("register state lost in worker " + id);
    let g = 0;
    for (const v of walk(3)) g += v;
    total = (total + after + g) % 1000003;
  }
  return total;
}
async function main(): Promise<void> {
  for (let wave = 0; wave < 4; wave++) {
    const jobs: Promise<number>[] = [];
    for (let i = 0; i < 150; i++) jobs.push(worker(wave * 1000 + i, 6, 2));
    const results = await Promise.all(jobs);
    let sum = 0;
    for (const r of results) sum = (sum + r) % 1000003;
    console.log("wave", wave, results.length, sum.toFixed(6));
  }
}
main().then(() => console.log("done"));
