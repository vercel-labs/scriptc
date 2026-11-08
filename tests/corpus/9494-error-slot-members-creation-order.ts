// `cause`, `code` and `name` assigned to an error of a built-in class are
// listed in the order the program created them, whichever comes first.
function keys(value: unknown): string {
  return Object.keys(value as object).join(",");
}
function names(value: unknown): string {
  return Object.getOwnPropertyNames(value as object).join(",");
}
type Coded = Error & { code?: string };

const a: Coded = new Error("a");
a.cause = "first";
a.code = "E_A";
console.log(keys(a), "|", names(a), "|", a.cause, a.code);

const b: Coded = new Error("b");
b.code = "E_B";
b.cause = "second";
console.log(keys(b), "|", names(b), "|", b.cause, b.code);

const c: Coded = new TypeError("c");
c.name = "Renamed";
c.cause = "third";
c.code = "E_C";
console.log(keys(c), "|", names(c), "|", String(c), c.cause, c.code);

const d: Coded = new RangeError("d");
d.code = "E_D";
d.name = "Other";
d.cause = "fourth";
console.log(keys(d), "|", names(d), "|", String(d), d.cause, d.code);

// The options' cause is created by the constructor, before anything else.
const e: Coded = new Error("e", { cause: "given" });
e.code = "E_E";
console.log(keys(e), "|", names(e), "|", e.cause, e.code);
e.cause = "changed";
console.log(keys(e), "|", names(e), "|", e.cause);

// An AggregateError's `errors` exists before a cause assigned later.
const many = new AggregateError([new Error("x")], "many");
many.cause = "all failed";
console.log(keys(many), "|", names(many), "|", many.cause, many.errors.length);

// Read back through an untyped reference.
console.log((a as any).cause, (a as any).code, "cause" in b, "code" in b);
