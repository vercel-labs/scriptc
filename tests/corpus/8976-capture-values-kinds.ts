// Captured bindings that are never reassigned, of every value kind: the
// closure must see the value the binding had when it was created, for as
// long as the closure lives.
class Counter {
  count = 0;
  readonly label: string;
  constructor(label: string) {
    this.label = label;
  }
  bump(): number {
    return ++this.count;
  }
}

interface Point {
  x: number;
  y: number;
}

type Reader = () => string;

function kinds(seed: number, name: string, flag: boolean): Reader[] {
  const n = seed * 2 + 1;
  const big = 2 ** 40 + seed;
  const text = `${name}:${seed}`;
  const yes = flag;
  const no = !flag;
  const list = [seed, seed + 1, seed + 2];
  const point: Point = { x: seed, y: -seed };
  const counter = new Counter(name);
  const map = new Map<string, number>([[name, seed]]);
  const set = new Set<string>([name, text]);
  const maybe: number | undefined = seed % 2 === 0 ? seed : undefined;
  const either: string | number = seed % 3 === 0 ? "s" + seed : seed;
  const nothing: Point | null = seed > 1 ? null : point;
  const inner = (suffix: string): string => text + suffix;
  let stable = name.toUpperCase();
  return [
    () => `n=${n} big=${big}`,
    () => `text=${text} yes=${yes} no=${no}`,
    () => `list=${list.join("|")} len=${list.length}`,
    () => `point=${point.x},${point.y}`,
    () => `counter=${counter.label}#${counter.bump()}`,
    () => `map=${map.get(name)} size=${map.size}`,
    () => `set=${[...set].join("|")}`,
    () => `maybe=${maybe === undefined ? "undefined" : maybe}`,
    () => `either=${typeof either}:${either}`,
    () => `nothing=${nothing === null ? "null" : nothing.x}`,
    () => `inner=${inner("!")}`,
    () => `stable=${stable} seed=${seed} name=${name} flag=${flag}`,
  ];
}

for (const seed of [0, 1, 2, 3]) {
  const readers = kinds(seed, "k" + seed, seed % 2 === 1);
  for (const read of readers) console.log(read());
  // The counter object is shared with the closure, not copied.
  console.log(readers[4]!(), readers[4]!());
}

// The value is shared, the binding is not: mutation through the value is
// visible, and a sibling binding that is reassigned stays live.
function shared(): string[] {
  const items: string[] = [];
  const add = (item: string): number => items.push(item);
  let total = 0;
  const tally = (): number => (total += items.length);
  add("a");
  add("b");
  const first = tally();
  add("c");
  const second = tally();
  return [...items, String(first), String(second), String(total)];
}
console.log(shared().join(","));

// Destructured bindings, defaults and rest elements.
function pieces(source: { a: number; b: string; rest?: number[] }, [head, ...tail]: string[]): () => string {
  const { a, b, rest = [7, 8] } = source;
  const [first = "none", second = "missing"] = tail;
  return () => `${a}/${b}/${rest.join("+")}/${head}/${first}/${second}/${tail.length}`;
}
console.log(pieces({ a: 1, b: "two" }, ["h", "t1"])());
console.log(pieces({ a: 3, b: "four", rest: [] }, ["h2"])());

// Declared without an initializer and assigned once later.
function assignedLater(flag: boolean): string {
  let once: string;
  once = flag ? "yes" : "no";
  let either: number;
  if (flag) either = 1;
  else either = 2;
  let label: string;
  const early = (): string => String(label);
  label = "set";
  const read = (): string => `${once}:${either}:${label}`;
  return `${early()} ${read()}`;
}
console.log(assignedLater(true), assignedLater(false));

// Two and three levels down, with a parameter and a local at each level.
function levels(a: number): (b: number) => (c: number) => () => string {
  const a2 = a * 10;
  return (b) => {
    const b2 = b * 100;
    return (c) => {
      const c2 = c * 1000;
      return () => `${a}+${a2}+${b}+${b2}+${c}+${c2}=${a + a2 + b + b2 + c + c2}`;
    };
  };
}
const level1 = levels(1);
const level2a = level1(2);
const level2b = level1(3);
console.log(level2a(4)(), level2b(5)(), levels(6)(7)(8)());

// A binding captured by value and one captured by reference in one
// environment, with the mutable one written from both sides.
function mixed(prefix: string): { next: () => string; reset: () => void } {
  let serial = 0;
  const width = prefix.length + 2;
  return {
    next: () => `${prefix}${String(++serial).padStart(width, "0")}`,
    reset: () => {
      serial = 0;
    },
  };
}
const ids = mixed("id-");
console.log(ids.next(), ids.next());
ids.reset();
console.log(ids.next());

// Closures that outlive many calls keep their own values apart.
const made: Reader[] = [];
for (let i = 0; i < 5; i++) made.push(...kinds(i + 10, "m" + i, i % 2 === 0).slice(0, 2));
console.log(made.map((read) => read()).join(" ; "));

// A function value captured by value is the same function.
function identity(): boolean {
  const f = (): number => 1;
  const g = (): (() => number) => f;
  return g() === f && g() === g();
}
console.log(identity());
