// Parameters are observable: defaults, rest parameters, patterns, `this` and
// surplus parameters of a function literal behave the same whatever the
// signature of the slot the literal is written into.
type Step = (value: number, index: number, label: string) => string;

function drive(f: Step): string {
  return [f(1, 0, "a"), f(2, 1, "b")].join(" ");
}
function lengthOf(f: Step): number {
  return f.length;
}

// Default values: evaluated per call, left to right, only when the argument
// is undefined. The slot always passes a value here.
const order: string[] = [];
function mark(tag: string, value: number): number {
  order.push(tag);
  return value;
}
console.log(
  "default",
  drive((value = mark("d0", 7)) => `v${value}`),
  drive((value, index = mark("d1", 9)) => `v${value}i${index}`),
  order.join(","),
);
// A slot whose parameters are optional passes undefined, and the default applies.
type Maybe = (value?: number, index?: number) => string;
function omit(f: Maybe): string {
  return [f(), f(5), f(undefined, 6), f(7, 8)].join(" ");
}
console.log("omitted", omit((value = 40) => `${value}`));
console.log("omitted pair", omit((value = 40, index = value + 1) => `${value}/${index}`));
console.log("omitted none", omit(() => "none"));
console.log("omitted optional", omit((value) => (value === undefined ? "u" : `${value}`)));
function maybeLength(f: Maybe): number {
  return f.length;
}
console.log(
  "default length",
  maybeLength((value = 40) => `${value}`),
  maybeLength(() => ""),
  maybeLength((value) => `${value}`),
  maybeLength((value, index) => `${value}${index}`),
);

// Rest parameters collect what the caller passed.
type Many = (first: number, second: number, third: number) => number;
function three(f: Many): number {
  return f(1, 2, 3);
}
console.log(
  "rest",
  three((...all) => all.length),
  three((first, ...others) => first * 100 + others.length),
  three((...all: number[]) => all.reduce((a, b) => a + b, 0)),
);
// Destructuring patterns.
type OnPoint = (point: { x: number; y: number }, index: number, tag: string) => number;
function points(f: OnPoint): number {
  return f({ x: 1, y: 2 }, 0, "p") + f({ x: 10, y: 20 }, 1, "q");
}
console.log(
  "pattern",
  points(({ x }) => x),
  points(({ x, y }) => x * y),
  points(({ y }, index) => y + index),
);
type OnPair = (pair: [number, string], index: number) => string;
function pairs(f: OnPair): string {
  return f([1, "one"], 0) + f([2, "two"], 1);
}
console.log("tuple pattern", pairs(([n, name]) => `${n}=${name};`), pairs(([, name]) => name));

// A literal with more parameters than the slot passes: the extras are undefined.
type One = (value: number) => string;
function once(f: One): string {
  return f(3);
}
console.log(
  "surplus",
  once((value, extra?: number) => `${value}:${extra === undefined ? "none" : extra}`),
  once((value, extra = 4) => `${value}:${extra}`),
);

// Errors thrown from a literal's body and from a default.
function boom(): number {
  throw new Error("default failed");
}
try {
  drive((value) => {
    if (value === 2) throw new RangeError("body failed");
    return "ok";
  });
} catch (error) {
  console.log("body throw", error instanceof RangeError, (error as Error).message);
}
try {
  omit((value = boom()) => `${value}`);
} catch (error) {
  console.log("default throw", (error as Error).message);
}
