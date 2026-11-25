// The %s conversion of a format string known only at run time calls an
// object's own toString, as String(value) does; an object without one is
// inspected. The record literals here are built by typed code and reach the
// formatter untyped.
import { format } from "node:util";

const pair: string = process.argv.length > 99 ? "" : "%s|%s";
const one: string = process.argv.length > 99 ? "" : "%s";

class Plain {
  a = 1;
}
const own = { toString: () => "custom text" };
const ownMethod = {
  toString(): string {
    return "method text";
  },
  extra: 1,
};
const notFunction = { toString: 5 };
const nested = { inner: own };

console.log(pair, own, ownMethod);
console.log(pair, new Plain(), { a: 1, b: { c: { d: 1 } } });
console.log(pair, [1, own], nested);
console.log(pair, notFunction, 5n);
console.log(pair, -0, null);
console.log(pair, undefined, true);
console.log(pair, new Date(0), new Map([[1, 2]]));
console.log(format(pair, own, ownMethod));
console.error(pair, own, ownMethod);
console.log(one, { valueOf: () => 7 });
try {
  console.log(one, {
    toString(): string {
      throw new RangeError("from toString");
    },
  });
} catch (error) {
  console.log("threw", (error as Error).name, (error as Error).message);
}
