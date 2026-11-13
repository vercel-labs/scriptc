// util.format's numeric conversions over non-primitive arguments. %d is
// Number(arg) — a record's valueOf, a Map's NaN, a typed array's join read
// through ToPrimitive; %i is parseInt(String(arg)) and %f is
// parseFloat(String(arg)), so an object's own toString decides (a Date's
// text parses to NaN, a class returning "3.5 apples" to 3.5). A symbol
// prints NaN in all three, -0 prints 0, and a bigint keeps its decimal
// text (%d/%i print `${n}n`, %f reads its number). Node is the oracle.
import { format } from "node:util";

class Amount {
  n = 5;
  valueOf(): number {
    return this.n;
  }
}
class Text {
  toString(): string {
    return "3.5 apples";
  }
}
const view = new DataView(new ArrayBuffer(2));
const record = { a: 1 };

console.log(format("%d", new Uint8Array([7, 8])));
console.log(format("%d", [1, 2]));
console.log(format("%d", record));
console.log(format("%d", new Amount()));
console.log(format("%d", new Text()));
console.log(format("%d", new URL("http://a/")));
console.log(format("%d", new Date(0)));
console.log(format("%d", new Map([["a", 1]])));
console.log(format("%d", /ab/));
console.log(format("%d", view));
console.log(format("%d", true), format("%d", "3.9"), format("%d", 5n), format("%d", -0));

console.log(format("%i", new Uint8Array([7, 8])));
console.log(format("%i", [1.9, 2]));
console.log(format("%i", record));
console.log(format("%i", new Amount()));
console.log(format("%i", new Text()));
console.log(format("%i", new URL("http://a/")));
console.log(format("%i", new Date(0)));
console.log(format("%i", new Set([1])));
console.log(format("%i", /ab/));
console.log(format("%i", view));
console.log(format("%i", true), format("%i", "12px"), format("%i", 10n), format("%i", -0));

console.log(format("%f", new Uint8Array([7, 8])));
console.log(format("%f", [1.5, 2]));
console.log(format("%f", record));
console.log(format("%f", new Amount()));
console.log(format("%f", new Text()));
console.log(format("%f", new URL("http://a/")));
console.log(format("%f", new Date(0)));
console.log(format("%f", /ab/));
console.log(format("%f", view));
console.log(format("%f", 10n), format("%f", "1.5e2"), format("%f", -0), format("%f", Infinity));

const sym = Symbol("s");
console.log(format("%s|%d|%i|%f", sym, sym, sym, sym));
console.log(format("%d %i %f", new Text(), new Text(), new Text()));

// The conversions compose with the format string's own text and with the
// rest-args tail.
console.log(format("row %d of %d (%s)", 3, 10, record));
console.log(format("%i", new Text(), "tail", record));
