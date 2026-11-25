// Fields declared with a definite-assignment assertion (`x!: T`) or with
// `declare`, which tsc does not check, read before anything assigns them.
// Each reads undefined to `typeof`, the comparisons, truthiness and `??`.

class Svc {
  id = 1;
}
type Rec = { a: number };
const DA: number[] = [9];
const DS = new Set<string>();
const DI = new Svc();
const DR: Rec = { a: 9 };
const DF = (x: number): number => x;

class Late {
  n!: number;
  b!: boolean;
  s!: string;
  big!: bigint;
  arr!: number[];
  st!: Set<string>;
  inst!: Svc;
  rec!: Rec;
  fn!: (x: number) => number;
  fill(): void {
    this.n = 1.5;
    this.b = true;
    this.s = "str";
    this.big = 7n;
    this.arr = [1, 2];
    this.st = new Set(["x"]);
    this.inst = new Svc();
    this.rec = { a: 1 };
    this.fn = (x: number) => x * 2;
  }
  show(): void {
    console.log(
      "n",
      typeof this.n,
      this.n === undefined,
      this.n !== undefined,
      this.n == null,
      this.n ? "truthy" : "falsy",
      !this.n,
      (this.n ?? -1) === -1,
    );
    console.log(
      "b",
      typeof this.b,
      this.b === undefined,
      this.b !== undefined,
      this.b == null,
      this.b ? "truthy" : "falsy",
      !this.b,
      (this.b ?? false) === false,
    );
    console.log(
      "s",
      typeof this.s,
      this.s === undefined,
      this.s !== undefined,
      this.s == null,
      this.s ? "truthy" : "falsy",
      !this.s,
      (this.s ?? "dflt") === "dflt",
    );
    console.log(
      "big",
      typeof this.big,
      this.big === undefined,
      this.big !== undefined,
      this.big == null,
      this.big ? "truthy" : "falsy",
      !this.big,
      (this.big ?? 5n) === 5n,
    );
    console.log(
      "arr",
      typeof this.arr,
      this.arr === undefined,
      this.arr !== undefined,
      this.arr == null,
      this.arr ? "truthy" : "falsy",
      !this.arr,
      (this.arr ?? DA) === DA,
    );
    console.log(
      "st",
      typeof this.st,
      this.st === undefined,
      this.st !== undefined,
      this.st == null,
      this.st ? "truthy" : "falsy",
      !this.st,
      (this.st ?? DS) === DS,
    );
    console.log(
      "inst",
      typeof this.inst,
      this.inst === undefined,
      this.inst !== undefined,
      this.inst == null,
      this.inst ? "truthy" : "falsy",
      !this.inst,
      (this.inst ?? DI) === DI,
    );
    console.log(
      "rec",
      typeof this.rec,
      this.rec === undefined,
      this.rec !== undefined,
      this.rec == null,
      this.rec ? "truthy" : "falsy",
      !this.rec,
      (this.rec ?? DR) === DR,
    );
    console.log(
      "fn",
      typeof this.fn,
      this.fn === undefined,
      this.fn !== undefined,
      this.fn == null,
      (this.fn ?? DF) === DF,
    );
  }
}
const late = new Late();
late.show();
late.fill();
late.show();

// `declare` fields emit nothing: the property does not exist until it is
// assigned.
class Tagged {
  declare tag: string;
  other!: number;
  show(): string {
    return [typeof this.tag, typeof this.other, this.tag ?? "notag", this.other ?? -1].join(":");
  }
}
const tagged = new Tagged();
console.log(tagged.show());
tagged.tag = "t";
tagged.other = 4;
console.log(tagged.show());

// Assigned by a method the constructor calls.
class Output {
  stream!: string[];
  width!: number;
  constructor() {
    this.initialize();
  }
  initialize(): void {
    console.log("before:", this.stream === undefined, this.width ?? "no width");
    this.stream = [];
    this.width = 80;
  }
  write(line: string): number {
    this.stream.push(line);
    return this.stream.length * this.width;
  }
}
console.log(new Output().write("a"));

// What a use of the unassigned field does.
function attempt(label: string, f: () => unknown): void {
  try {
    console.log(label, f());
  } catch (e) {
    console.log(label, "threw", e instanceof TypeError ? "TypeError" : "other");
  }
}
function uses(target: Late): void {
  attempt("n + 1", () => target.n + 1);
  attempt("String(n)", () => String(target.n));
  attempt("template n", () => `${target.n}`);
  attempt("String(b)", () => String(target.b));
  attempt("s.length", () => target.s.length);
  attempt("s + x", () => target.s + "x");
  attempt("big + 1n", () => target.big + 1n);
  attempt("arr.length", () => target.arr.length);
  attempt("st.size", () => target.st.size);
  attempt("inst.id", () => target.inst.id);
  attempt("rec.a", () => target.rec.a);
  attempt("fn(2)", () => target.fn(2));
}
uses(new Late());
uses(late);
