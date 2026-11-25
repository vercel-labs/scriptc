// util.types.isArgumentsObject answers the arguments object's internal
// brand: true for `arguments`, false for arrays, array-likes, rest
// parameters and every other value, and the other brands answer false for
// the object. Asked through util.types, the named import and
// node:util/types alike.
import * as util from "node:util";
import { types } from "node:util";
import * as direct from "node:util/types";

function overloaded(a: number, b: string): string {
  return [
    util.types.isArgumentsObject(arguments),
    types.isArgumentsObject(arguments),
    direct.isArgumentsObject(arguments),
    types.isDate(arguments),
    types.isMap(arguments),
  ].join(" ");
}
console.log("direct", overloaded(1, "x"));

function rest(...parts: number[]): boolean {
  return types.isArgumentsObject(parts);
}
console.log("rest", rest(1, 2));

const list: unknown[] = [[1, 2], { length: 0 }, "text", 7, null, undefined, new Uint8Array(1)];
console.log("others", list.map((value) => types.isArgumentsObject(value)).join(" "));

const stored = types.isArgumentsObject;
console.log("stored", stored([1]), stored({ length: 1, 0: 1 }));
