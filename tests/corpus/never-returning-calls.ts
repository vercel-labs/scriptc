// A call to a function returning `never` can stand wherever a value is
// expected: it still runs (and throws), and the surrounding expression
// never needs its value. Each case runs both its normal path and its
// throwing path.

class Point {
  x: number;
  constructor(x: number) {
    this.x = x;
  }
}

function fail(message: string): never {
  throw new Error(message);
}
function rangeFail(): never {
  throw new RangeError("out of range");
}

function lengthOf(text: string): number {
  if (text.length > 0) return text.length;
  return fail("empty input");
}
function checked(text: string): number {
  const n: number = text.length > 0 ? text.length : fail("no length");
  return n;
}
function labelOf(value: string | undefined): string {
  return value ?? fail("missing label");
}
function pointOf(value: Point | undefined): Point {
  return value ?? fail("missing point");
}
const makePoint = (ok: boolean): Point => (ok ? new Point(3) : rangeFail());
const count: () => number = () => fail("no count");
function listOf(ok: boolean): string[] {
  if (ok) return ["a"];
  const items: string[] = fail("no list");
  return items;
}
function maybe(flag: boolean): number | undefined {
  if (flag) return 1;
  return fail("no maybe");
}
function twice(n: number): number {
  return n * 2;
}
function same<T>(value: T): T {
  return value;
}

class Reader {
  pos = 0;
  error(message: string): never {
    throw new SyntaxError(message + " at " + this.pos);
  }
  digit(c: string): number {
    return c >= "0" && c <= "9" ? c.charCodeAt(0) - 48 : this.error("bad digit " + c);
  }
}

function attempt(label: string, run: () => unknown): void {
  try {
    console.log(label, run());
  } catch (e) {
    if (e instanceof Error) console.log(label, "caught", e.name, e.message);
  }
}

attempt("length", () => lengthOf("abc"));
attempt("length empty", () => lengthOf(""));
attempt("checked", () => checked("ab"));
attempt("checked empty", () => checked(""));
attempt("label", () => labelOf("tag"));
attempt("label missing", () => labelOf(undefined));
attempt("point", () => pointOf(new Point(5)).x);
attempt("point missing", () => pointOf(undefined).x);
attempt("arrow", () => makePoint(true).x);
attempt("arrow fails", () => makePoint(false).x);
attempt("count", () => count());
attempt("list", () => listOf(true).length);
attempt("list fails", () => listOf(false).length);
attempt("maybe", () => maybe(true));
attempt("maybe fails", () => maybe(false));
attempt("argument", () => twice(fail("as argument")));
let total = 0;
attempt("generic", () => same<number>(total > 0 ? total : fail("generic")));
attempt("assigned", () => {
  total = fail("assigned");
  return total;
});
attempt("digit", () => new Reader().digit("7"));
attempt("digit fails", () => new Reader().digit("q"));

async function load(ok: boolean): Promise<number> {
  if (ok) return 7;
  return fail("async failure");
}
load(true).then((v) => console.log("async", v));
load(false).catch((e) => {
  if (e instanceof Error) console.log("async caught", e.message);
});
