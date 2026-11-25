// Several `for … of` loops, a spread and an Array.from call over values held as
// `any`, some of them instances of classes with [Symbol.iterator]. Each site
// opens the class's own iterator, and a value that is not iterable fails with
// the name its own site spells, not another site's.

class Countdown {
  readonly from: number;
  constructor(from: number) {
    this.from = from;
  }
  *[Symbol.iterator](): Generator<number> {
    for (let i = this.from; i > 0; i--) yield i;
  }
}

class Pair {
  readonly left: string;
  readonly right: string;
  constructor(left: string, right: string) {
    this.left = left;
    this.right = right;
  }
  *[Symbol.iterator](): Generator<string> {
    yield this.left;
    yield this.right;
  }
}

class Opaque {
  size = 3;
}

function message(action: () => unknown): string {
  try {
    return JSON.stringify(action());
  } catch (error) {
    return `${(error as Error).name}: ${(error as Error).message}`;
  }
}

function first(items: any): unknown[] {
  const seen: unknown[] = [];
  for (const item of items) seen.push(item);
  return seen;
}

function second(collection: any): unknown[] {
  const seen: unknown[] = [];
  for (const entry of collection) seen.push(entry, entry);
  return seen;
}

function third(source: any): unknown[] {
  return [...source];
}

function fourth(candidates: any): unknown[] {
  return Array.from(candidates);
}

const values: [string, any][] = [
  ["countdown", new Countdown(3)],
  ["pair", new Pair("l", "r")],
  ["array", [1, 2]],
  ["string", "ab"],
  ["set", new Set(["s"])],
  ["opaque", new Opaque()],
  ["number", 7],
  ["null", null],
  ["undefined", undefined],
];

for (const [title, value] of values) {
  console.log(title, "first", message(() => first(value)));
  console.log(title, "second", message(() => second(value)));
  console.log(title, "third", message(() => third(value)));
  console.log(title, "fourth", message(() => fourth(value)));
}
