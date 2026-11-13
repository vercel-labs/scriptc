// util.format's object rules. %s takes String(arg) when the toString the
// value reaches is the program's own — a class method, a record's method or
// arrow field, or a record reached through its index signature — and
// inspects at depth 0 otherwise (a class with no override, an Error, a
// nested object). The rest-args tail is a different rule: only strings pass
// verbatim and every other value inspects, so the same object prints through
// its toString under %s and through inspect after the format string's
// substitutions are spent. %f reads a bigint as a number and %j raises V8's
// BigInt serialization TypeError. Node is the oracle.
import { format, formatWithOptions } from "node:util";

class Named {
  n: number;
  constructor(n: number) {
    this.n = n;
  }
  toString(): string {
    return `named:${this.n}`;
  }
}
class Inherited extends Named {}
class Plain {
  n = 1;
}

type Rec = { n: number; toString(): string };
const record: Rec = {
  n: 2,
  toString(): string {
    return `rec:${this.n}`;
  },
};
const arrowRecord: Rec = { n: 3, toString: () => "arrow" };
const indexed: { [key: string]: unknown } = { n: 4, toString: () => "indexed" };
const plainRecord = { a: 1, b: "x" };

console.log(format("%s", new Named(1)));
console.log(format("%s", new Inherited(2)));
console.log(format("%s", new Plain()));
console.log(format("%s", record));
console.log(format("%s", arrowRecord));
console.log(format("%s", indexed));
console.log(format("%s", plainRecord));
console.log(format("%s", { a: { b: { c: 1 } } }));
console.log(format("%s", [1, [2, [3]]]));
console.log(format("%s", new Uint8Array([1, 2, 3])));
console.log(format("%s", new Float64Array([1.5, 2])));
console.log(format("%s", Buffer.from("hi")));
console.log(format("%s", new DataView(new ArrayBuffer(2))));
// A URL and its searchParams answer String(value): the href and the
// serialized list, not the inspected shape.
const link = new URL("http://example.com/p?x=1&y=2#h");
console.log(format("%s", link));
console.log(format("%s|%s", link, link.searchParams));
console.log(format("tail", link, link.searchParams));
console.log(format("%s", new Date(0)), format("%s", /a/g));
console.log(format("%s", new Map([["a", 1]])), format("%s", new Set([1])));
console.log(format("%s|%s|%s", new Named(5), record, plainRecord));

// The rest-args tail inspects the same values.
console.log(format("rest", new Named(6), record, arrowRecord, plainRecord, [1, [2]]));
console.log(format("%s rest", new Named(7), new Named(8), plainRecord));

// The receiver expression evaluates once even when the conversion runs twice.
let made = 0;
function make(): Rec {
  made++;
  return { n: made, toString(): string { return `made:${this.n}`; } };
}
console.log(format("%s %s", make(), make()), made);

// %f and %j over bigints.
console.log(format("%f", 15n));
console.log(format("%f|%d|%i", 1n, 2n, 3n));
try {
  console.log(format("%j", 4n));
} catch (e) {
  const err = e as Error;
  console.log("throw", err.name, err.message);
}
console.log(format("%j", { a: 1 }));

// formatWithOptions keeps its depth for the inspected forms and passes the
// rest-args tail the same rule.
console.log(formatWithOptions({ depth: 1 }, "%s", { a: { b: { c: 1 } } }));
console.log(formatWithOptions({ depth: 1 }, "%O", { a: { b: { c: 1 } } }));
console.log(formatWithOptions({ depth: 0 }, "tail", plainRecord));

// A format string the compiler cannot read runs Node's loop at run time,
// with the same conversions for checked-dynamic values.
const dynamic: string = ["%s", "%O"].join(" ");
console.log(format(dynamic, plainRecord, plainRecord));
console.log(format(["%s"].join(""), record));
const n: number = 9;
console.log(format(String(n) + "%s", plainRecord));
