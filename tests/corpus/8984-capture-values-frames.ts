// Captures by generators and async functions, whose frames outlive the
// call, and reference cycles through closures.
function* countdown(from: number, label: string): Generator<string, string> {
  const prefix = label + ":";
  const format = (n: number): string => prefix + n;
  for (let n = from; n > 0; n--) {
    const step = format(n);
    const again = yield step;
    void again;
  }
  return prefix + "done";
}

function makeGenerators(): string {
  const a = countdown(2, "a");
  const b = countdown(3, "b");
  const out: string[] = [];
  for (let turn = 0; turn < 4; turn++) {
    const ra = a.next();
    const rb = b.next();
    out.push(`${ra.value}${ra.done ? "!" : ""} ${rb.value}${rb.done ? "!" : ""}`);
  }
  return out.join(" | ");
}
console.log(makeGenerators());

// A generator closure over a parameter and a local of its creator.
function lazySquares(limit: number): () => Generator<number> {
  const scale = limit * 10;
  return function* (): Generator<number> {
    for (let i = 1; i <= limit; i++) yield i * i + scale;
  };
}
const squares = lazySquares(3);
console.log([...squares()].join(","), [...squares()].join(","), [...lazySquares(1)()].join(","));

class Node {
  next: Node | null = null;
  onVisit: (() => string) | null = null;
  readonly id: number;
  constructor(id: number) {
    this.id = id;
  }
}

// Object and closure pointing at each other; nothing else keeps them.
function cycles(count: number): string {
  let last = "";
  for (let i = 0; i < count; i++) {
    const node = new Node(i);
    const partner = new Node(-i);
    node.next = partner;
    partner.next = node;
    node.onVisit = () => `visit ${node.id}->${partner.id}`;
    partner.onVisit = () => node.onVisit!() + "'";
    const handlers: (() => string)[] = [];
    handlers.push(() => `${handlers.length}:${partner.onVisit!()}`);
    last = handlers[0]!();
  }
  return last;
}
console.log(cycles(2000));

// A closure that captures a closure that captures the first one's holder.
function ring(): string {
  const holder: { call: (() => string) | null } = { call: null };
  const inner = (): string => (holder.call === null ? "empty" : "full");
  const outer = (): string => inner() + "/" + inner.name.length;
  holder.call = outer;
  return holder.call();
}
console.log(ring());

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchLabel(id: number, delay: number): Promise<string> {
  const tag = "job" + id;
  await sleep(delay);
  const stamp = (suffix: string): string => `${tag}-${suffix}`;
  await sleep(1);
  return stamp("done");
}

async function pipeline(names: string[]): Promise<string[]> {
  const results: string[] = [];
  const record = (line: string): number => results.push(line);
  const tasks = names.map(async (name, index) => {
    const upper = name.toUpperCase();
    await sleep(1);
    record(`${index}:${upper}`);
    return async (): Promise<string> => {
      await sleep(1);
      return upper + "/" + names.length;
    };
  });
  const followUps = await Promise.all(tasks);
  for (const followUp of followUps) record(await followUp());
  return results;
}

async function* ticker(limit: number, unit: string): AsyncGenerator<string> {
  const describe = (n: number): string => `${n}${unit}`;
  for (let n = 1; n <= limit; n++) {
    await sleep(1);
    yield describe(n);
  }
}

// Timers keep closures alive after their creator has returned.
function schedule(lines: string[], done: () => void): void {
  const total = 3;
  let fired = 0;
  for (let i = 0; i < total; i++) {
    const label = `timer${i}`;
    setTimeout(() => {
      lines.push(`${label} of ${total}`);
      if (++fired === total) done();
    }, 1);
  }
}

async function main(): Promise<void> {
  console.log(await fetchLabel(1, 2), await fetchLabel(2, 1));
  console.log((await Promise.all([fetchLabel(3, 3), fetchLabel(4, 1)])).join(","));
  console.log((await pipeline(["x", "y", "z"])).join(" "));
  const ticks: string[] = [];
  for await (const tick of ticker(3, "ms")) ticks.push(tick);
  console.log(ticks.join(","));
  const lines: string[] = [];
  await new Promise<void>((resolve) => schedule(lines, resolve));
  console.log(lines.join(" | "));
  const rejected = async (reason: string): Promise<string> => {
    const wrapped = `wrapped ${reason}`;
    await sleep(1);
    throw new Error(wrapped);
  };
  try {
    await rejected("failure");
  } catch (error) {
    const message = (error as Error).message;
    const report = (): string => "caught: " + message;
    console.log(report());
  }
}

main().then(() => console.log("finished"));
