// Ordering of `await Promise.all([...])` of never-suspending async calls
// against concurrent microtasks.
const log: string[] = [];

async function value(n: number): Promise<number> {
  log.push(`value ${n}`);
  return n * 10;
}
async function fail(tag: string): Promise<number> {
  log.push(`fail ${tag}`);
  throw new Error(`boom ${tag}`);
}
async function label(s: string): Promise<string> {
  log.push(`label ${s}`);
  return s.toUpperCase();
}

function ticker(name: string, turns: number): Promise<void> {
  let p = Promise.resolve();
  for (let i = 0; i < turns; i++) p = p.then(() => void log.push(`${name} tick ${i}`));
  return p;
}

async function literal(): Promise<void> {
  const r: number[] = await Promise.all([value(1), value(2), value(3)]);
  log.push(`literal ${r.join(",")}`);
}
async function local(): Promise<void> {
  const ps = [value(4), value(5)];
  const r = await Promise.all(ps);
  log.push(`local ${r.join(",")}`);
}
async function firstRejects(): Promise<void> {
  try {
    await Promise.all([fail("a"), value(6), fail("b")]);
    log.push("firstRejects resolved");
  } catch (e) {
    log.push(`firstRejects caught ${(e as Error).message}`);
  }
}
async function middleRejects(): Promise<void> {
  const ps = [value(7), fail("c"), value(8)];
  try {
    const r = await Promise.all(ps);
    log.push(`middleRejects resolved ${r.length}`);
  } catch (e) {
    log.push(`middleRejects caught ${(e as Error).message}`);
  }
}
async function strings(): Promise<void> {
  const r: string[] = await Promise.all([label("x"), label("y")]);
  log.push(`strings ${r.join("+")}`);
}
async function single(): Promise<void> {
  const all: number[] = await Promise.all([value(9)]);
  const only = all[0];
  log.push(`single ${only}`);
}
async function reused(): Promise<void> {
  const ps = [value(11), value(12)];
  const r = await Promise.all(ps);
  log.push(`reused ${r.join(",")} ${ps.length}`);
}
async function afterAssign(): Promise<void> {
  let r: number[] = [];
  const ps = [value(13)];
  r = await Promise.all(ps);
  log.push(`afterAssign ${r.join(",")}`);
}

async function main(): Promise<void> {
  await Promise.all([
    ticker("t", 8),
    literal(),
    ticker("u", 4),
    local(),
    firstRejects(),
    middleRejects(),
    strings(),
    single(),
    reused(),
    afterAssign(),
  ]);
  for (const line of log) console.log(line);
}
void main();
