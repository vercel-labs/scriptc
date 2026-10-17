// Many concurrently suspended stackless async calls: twenty thousand calls
// park on timers and on one shared pending promise at once, chains of
// nested awaits suspend at their leaves, and each continuation still
// resumes in Node's order with its own locals intact.
const count = 20000;
let resolveGate: (v: number) => void = () => {};
const gate = new Promise<number>((resolve) => {
  resolveGate = resolve;
});
const order: number[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function parked(i: number): Promise<number> {
  const local = i * 3;
  const label = "task" + i;
  const g = await gate;
  if (i % 4000 === 0) order.push(i);
  await sleep(i % 3);
  return local + g + label.length;
}

async function chain(depth: number, i: number): Promise<number> {
  if (depth === 0) {
    const g = await gate;
    return g + i;
  }
  const below = await chain(depth - 1, i);
  return below + depth;
}

async function main(): Promise<void> {
  const tasks: Promise<number>[] = [];
  for (let i = 0; i < count; i++) tasks.push(parked(i));
  const chains: Promise<number>[] = [];
  for (let i = 0; i < 500; i++) chains.push(chain(12, i));
  console.log("spawned", tasks.length, chains.length);
  await sleep(1);
  resolveGate(5);
  let sum = 0;
  for (const t of tasks) sum += await t;
  let chainSum = 0;
  for (const c of chains) chainSum += await c;
  console.log("sum", sum, "chains", chainSum, "order", order.join(","));
}

void main();
