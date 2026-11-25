// A function literal whose declared parameter type differs from what its
// slot passes: wider (unknown, a larger union), and narrower through a
// method's bivariant parameter. The body sees its own declared type.
type OnNumber = (value: number, index: number) => string;

function numbers(f: OnNumber): string {
  return [f(1.5, 0), f(-2, 1)].join(" ");
}

console.log("unknown", numbers((value: unknown) => typeof value));
console.log("unknown pair", numbers((value: unknown, index: unknown) => `${typeof value}${typeof index}`));
console.log(
  "wider union",
  numbers((value: number | string) => (typeof value === "number" ? value.toFixed(1) : value.toUpperCase())),
);
console.log(
  "wider optional",
  numbers((value: number | undefined) => (value === undefined ? "none" : String(value * 2))),
);
console.log("wider null", numbers((value: number | null, index: number | null) => `${value ?? "n"}/${index ?? "n"}`));

// Records and classes.
interface Named {
  name: string;
}
class Animal implements Named {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
}
class Dog extends Animal {
  bark(): string {
    return `${this.name} barks`;
  }
}
type OnDog = (dog: Dog, index: number) => string;
function dogs(f: OnDog): string {
  return [f(new Dog("rex"), 0), f(new Dog("fido"), 1)].join(", ");
}
console.log("base class", dogs((animal: Animal) => animal.name));
console.log("unknown class", dogs((value: unknown) => (value instanceof Dog ? value.bark() : "?")));
console.log("union class", dogs((value: Dog | string) => (typeof value === "string" ? value : value.name)));

// A method parameter is bivariant: the literal may declare a narrower type
// than the slot passes. The values passed here honour the narrower type.
interface Handler {
  handle(value: number | string, index: number): string;
}
const narrow: Handler = { handle: (value: number) => value.toFixed(2) };
console.log("narrower", narrow.handle(3, 0), narrow.handle.length);
const narrowBoth: Handler = { handle: (value: string, index: number) => value.repeat(index) };
console.log("narrower string", narrowBoth.handle("ab", 2), narrowBoth.handle.length);

// A generic slot: the literal is typed by the instantiated signature.
function mapEach<T, R>(xs: T[], f: (value: T, index: number, all: T[]) => R): R[] {
  const out: R[] = [];
  for (let i = 0; i < xs.length; i++) out.push(f(xs[i]!, i, xs));
  return out;
}
console.log("generic", mapEach([1, 2, 3], (x) => x * 2).join(","), mapEach(["a", "b"], (s) => s + s).join(","));
console.log("generic none", mapEach([1, 2, 3], () => "k").join(""));
console.log("generic unknown", mapEach([1, "two", true], (v: unknown) => typeof v).join(","));
function lengthThrough<T>(f: (value: T, index: number) => void): number {
  return f.length;
}
console.log("generic length", lengthThrough<number>(() => {}), lengthThrough<string>((s) => { void s; }));

// A slot whose result is wider than the literal's.
type Find = (value: number, index: number) => number | undefined;
function firstDefined(xs: number[], f: Find): number | undefined {
  for (let i = 0; i < xs.length; i++) {
    const found = f(xs[i]!, i);
    if (found !== undefined) return found;
  }
  return undefined;
}
console.log("wider result", firstDefined([1, 2, 3], (x) => (x > 1 ? x * 10 : undefined)), firstDefined([1], () => undefined));
type Describe = (value: number, index: number) => string | number;
function describe(f: Describe): string {
  return `${f(1, 0)}|${f(2, 1)}`;
}
console.log("union result", describe((x) => x), describe((x) => `#${x}`), describe((x): number => x + 1));

// A void slot discards the literal's result.
type Effect = (value: number, index: number) => void;
function effects(f: Effect): void {
  f(1, 0);
  f(2, 1);
}
const pushed: number[] = [];
effects((x) => pushed.push(x));
effects((x): number => pushed.push(x * 10));
console.log("void slot", pushed.join(","));

// Async literals.
type Load = (id: number, attempt: number) => Promise<string>;
async function load(f: Load): Promise<string> {
  return (await f(1, 0)) + (await f(2, 1));
}
load(async (id) => `<${id}>`).then((text) => console.log("async", text));
load(async () => "x").then((text) => console.log("async none", text));
