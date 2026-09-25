// Async bodies suspend as heap-allocated coroutine frames rather than on a
// fiber stack, so every value live across an await has to survive in the
// frame: partially evaluated operands and call arguments, loop-carried
// state, refcounted records and strings, closure captures, try/finally
// obligations, and a hundred concurrently suspended calls.
type Point = { x: number; y: number };

function tick(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(() => resolve(), ms);
  });
}

async function num(v: number): Promise<number> {
  await tick(0);
  return v;
}

async function str(v: string): Promise<string> {
  await tick(0);
  return v;
}

async function operands(): Promise<void> {
  const label = "sum";
  const total = 1 + (await num(2)) * 3 + (await num(4));
  const text = `${await str("a")}-${await str("b")}-${label}`;
  const arr = [await num(1), 2, await num(3)];
  const p: Point = { x: await num(5), y: await num(6) };
  let acc = 10;
  acc += await num(5);
  acc *= await num(2);
  console.log("operands", label + "=" + total, text, arr.join(","), p.x + ":" + p.y, acc);
}

const trace: string[] = [];
function first(): number {
  trace.push("first");
  return 1;
}
function third(): number {
  trace.push("third");
  return 3;
}
function combine(a: number, b: number, c: number): number {
  trace.push("combine");
  return a * 100 + b * 10 + c;
}

async function args(): Promise<void> {
  const r = combine(first(), await num(2), third());
  console.log("args", r, trace.join(" "));
}

async function loops(): Promise<void> {
  let acc = 0;
  for (let i = 0; i < 6; i++) {
    if (i === 1) continue;
    acc += await num(i * 10);
    if (acc > 60) break;
  }
  let j = 0;
  while (j < 3) {
    acc += await num(j);
    j++;
  }
  const words: string[] = [];
  for (const w of ["x", "y", "z"]) words.push(w + (await str(w)));
  console.log("loops", acc, words.join(""));
}

async function cleanup(fail: boolean): Promise<string> {
  const log: string[] = [];
  try {
    log.push("try");
    await tick(1);
    if (fail) throw new Error("boom");
    log.push("after");
  } catch (e) {
    if (e instanceof Error) log.push("catch " + e.message);
    await tick(1);
  } finally {
    await tick(1);
    log.push("finally");
  }
  return log.join(",");
}

async function rethrow(): Promise<number> {
  await tick(0);
  throw new Error("late failure");
}

async function captured(): Promise<void> {
  let count = 0;
  const bump = (): number => ++count;
  bump();
  await tick(0);
  bump();
  const later = await num(10);
  console.log("captured", count, later + bump());
}

async function worker(id: number): Promise<string> {
  const name = "w" + id;
  const p: Point = { x: id, y: 0 };
  await tick(id % 2);
  const q: Point = { x: 0, y: id };
  await num(id);
  return name + ":" + (p.x + q.y);
}

async function crowd(): Promise<void> {
  const jobs: Promise<string>[] = [];
  for (let i = 0; i < 100; i++) jobs.push(worker(i));
  const out = await Promise.all(jobs);
  let ok = 0;
  for (let i = 0; i < out.length; i++) {
    if (out[i] === "w" + i + ":" + 2 * i) ok++;
  }
  console.log("crowd", out.length, ok, out[99]);
}

async function immediate(n: number): Promise<number> {
  if (n < 0) await tick(0);
  return n * 2;
}

async function ordering(): Promise<void> {
  const seen: string[] = [];
  const a = immediate(1).then((v) => {
    seen.push("a" + v);
  });
  queueMicrotask(() => {
    seen.push("micro");
  });
  const b = immediate(2).then((v) => {
    seen.push("b" + v);
  });
  seen.push("sync");
  await a;
  await b;
  console.log("ordering", seen.join(" "));
}

async function hops(): Promise<void> {
  const order: string[] = [];
  const side = async (): Promise<void> => {
    order.push("side-start");
    await null;
    order.push("side-end");
  };
  const s = side();
  const x = await 42;
  order.push("x" + x);
  await undefined;
  order.push("after-undefined");
  await s;
  console.log("hops", order.join(" "));
}

async function depth(n: number): Promise<number> {
  if (n === 0) return 0;
  const below = await depth(n - 1);
  return below + 1;
}

async function main(): Promise<void> {
  await operands();
  await args();
  await loops();
  console.log("cleanup", await cleanup(false), "|", await cleanup(true));
  try {
    await rethrow();
  } catch (e) {
    if (e instanceof Error) console.log("caught", e.message);
  }
  await captured();
  await crowd();
  await ordering();
  await hops();
  console.log("depth", await depth(200));
}

main();
