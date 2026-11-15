// String conversion of values whose class is not known where they are
// converted: an untyped array's join, String() and a template over it. An
// instance of a class without a toString of its own converts as Node's
// Object.prototype.toString does, a Symbol.toStringTag getter names it, and
// a typed record's own toString function runs.
class Plain {
  a = 1;
}
class Tagged {
  get [Symbol.toStringTag](): string {
    return "Tagged";
  }
}
const record = { toString: (): string => "record text" };

const parts: unknown[] = [new Plain(), "a", null, undefined, 1, new Tagged(), record];
console.log(parts.join("+"));
console.log(String(parts));
console.log(`${parts}`);
const nested: unknown[] = [1, [new Plain(), [record]]];
console.log(nested.join("|"), String(nested));
const sorted: unknown[] = ["b", record, "a"];
console.log(sorted.sort().join());
