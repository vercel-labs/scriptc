// A generator function, an async function and an async generator function
// name their kind: Object.prototype.toString answers [object
// GeneratorFunction], [object AsyncFunction] and [object
// AsyncGeneratorFunction], and the Symbol.toStringTag they inherit reads the
// same name. Every other function is [object Function] and inherits no tag.
export {};

function total(a: number, b: number): number {
  return a + b;
}
const difference = function (a: number, b: number): number {
  return a - b;
};
const scale = (a: number): number => a * 2;
async function fetchCount(): Promise<number> {
  return 3;
}
const fetchLater = async (): Promise<number> => 4;
function* steps(): Generator<number, void, void> {
  yield 1;
}
async function* feed(): AsyncGenerator<number, void, void> {
  yield 1;
}

class Meter {
  reading: number = 5;
  read(): number {
    return this.reading;
  }
}

const kit = {
  plain(): number {
    return 1;
  },
  *each(): Generator<number, void, void> {
    yield 1;
  },
  async later(): Promise<number> {
    return 1;
  },
  async *stream(): AsyncGenerator<number, void, void> {
    yield 1;
  },
};

const meter = new Meter();
const totalFromOne = total.bind(null, 1);

function tag(value: unknown): string {
  return Object.prototype.toString.call(value);
}

function inherited(value: unknown): string {
  if (typeof value !== "function") return "not a function";
  return String(Reflect.get(value, Symbol.toStringTag));
}

function untyped(value: any): string {
  return String(value[Symbol.toStringTag]);
}

const functions: Array<[string, unknown]> = [
  ["declaration", total],
  ["expression", difference],
  ["arrow", scale],
  ["async", fetchCount],
  ["async arrow", fetchLater],
  ["generator", steps],
  ["async generator", feed],
  ["class", Meter],
  ["class method", meter.read],
  ["bound", totalFromOne],
  ["method", kit.plain],
  ["generator method", kit.each],
  ["async method", kit.later],
  ["async generator method", kit.stream],
  ["builtin", Math.max],
];

for (const [label, value] of functions) {
  console.log(label, "|", tag(value), "|", inherited(value), "|", untyped(value), "|", typeof value);
}

// Asked where the function has its own static type.
console.log(
  Object.prototype.toString.call(total),
  Object.prototype.toString.call(scale),
  Object.prototype.toString.call(fetchCount),
  Object.prototype.toString.call(steps),
  Object.prototype.toString.call(feed),
  Object.prototype.toString.call(kit.each),
);
console.log(
  String(Reflect.get(total, Symbol.toStringTag)),
  String(Reflect.get(fetchLater, Symbol.toStringTag)),
  String(Reflect.get(steps, Symbol.toStringTag)),
  String(Reflect.get(feed, Symbol.toStringTag)),
);

// What the functions make keeps its own tag.
console.log(tag(steps()), tag(fetchCount()), tag(meter), tag([]), tag(null), tag(new Map()));
