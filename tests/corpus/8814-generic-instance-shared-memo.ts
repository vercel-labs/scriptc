// Generic instances share the type-memo entries whose mapping never read
// their bindings (TypeMapperCtx.typeMemoShared). The instances below mix
// types that mention `T` with types that do not — a shared recursive record,
// a shared callback shape, a class declared inside the factory (whose name
// takes the instance), and a generic class. Sharing an entry that did read a
// binding would hand the first instance's IR type to the others, so every
// instance must keep its own element slots while the shared ones stay
// identical.
interface Node2 {
  label: string;
  next: Node2 | null;
}

interface Holder<T> {
  value: T;
  count: number;
}

type Mapper<T> = (value: T, index: number) => string;

class Slot<T> {
  value: T;
  constructor(value: T) {
    this.value = value;
  }
  read(): T {
    return this.value;
  }
}

function chain(label: string, n: number): Node2 {
  let head: Node2 = { label: `${label}0`, next: null };
  for (let i = 1; i < n; i++) head = { label: `${label}${i}`, next: head };
  return head;
}

function drain(node: Node2 | null, into: string[]): void {
  for (let cur = node; cur !== null; cur = cur.next) into.push(cur.label);
}

function build<T>(value: T, count: number): Holder<T> {
  return { value, count };
}

function mapperFor<T>(fmt: (v: T) => string): Mapper<T> {
  return (value, index) => `${index}:${fmt(value)}`;
}

function render<T>(seed: T, fmt: (v: T) => string): string {
  // A class declared inside the generic function: its type takes the
  // instance's name, so its mapping may not be shared between instances.
  class Local {
    readonly held: T;
    constructor() {
      this.held = seed;
    }
    render(): string {
      return fmt(this.held);
    }
  }
  return new Local().render();
}

function sum(holder: Holder<number>): number {
  return holder.value + holder.count;
}

function run<T>(seed: T, fmt: (v: T) => string, shown: number): string[] {
  const h = build(seed, 2);
  const mapper = mapperFor(fmt);
  const out = [render(seed, fmt), mapper(seed, 1), `h=${h.count}`];
  if (typeof seed === "number") out.push(`sum=${sum(h as Holder<number>)}`);
  out.push(`shown=${shown}`);
  return out;
}

const lines: string[] = [];
for (const line of run(7, (v) => `n${v * 2}`, 1)) lines.push(line);
for (const line of run("xy", (v) => `s${v.length}`, 2)) lines.push(line);
for (const line of run(true, (v) => `b${v ? 1 : 0}`, 3)) lines.push(line);

const walked: string[] = [];
drain(chain("c", 4), walked);
lines.push(`chain=${walked.join(",")}`);

const slot = new Slot("first");
const numberSlot = new Slot(41);
lines.push(`slot=${slot.read()},${numberSlot.read() + 1}`);

console.log(lines.join("\n"));
