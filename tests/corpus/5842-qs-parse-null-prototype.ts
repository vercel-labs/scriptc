// querystring.parse and querystring.decode return a null-prototype
// object: inspection prints the "[Object: null prototype]" base,
// getPrototypeOf answers null, and ToPrimitive and Object.prototype
// methods throw TypeErrors. Spread copies keep Object.prototype.
import * as qs from "node:querystring";
import { inspect } from "node:util";

const parsed = qs.parse("a=1&b=2&b=3&c");
console.log(parsed);
console.log(inspect(parsed), inspect({ nested: parsed }), inspect([qs.parse("")]));
console.log(qs.decode("x=1;y=2", ";"));
console.log(Object.getPrototypeOf(parsed) === null, Object.keys(parsed), JSON.stringify(parsed));

const attempt = (label: string, f: () => unknown): void => {
  try {
    console.log(label, f());
  } catch (e) {
    console.log(label, (e as Error).name, (e as Error).message);
  }
};
attempt("String", () => String(parsed));
attempt("template", () => `${parsed}`);
attempt("concat", () => "q=" + parsed);
attempt("hasOwnProperty", () => parsed.hasOwnProperty("a"));
attempt("toString", () => parsed.toString());
console.log(Object.prototype.toString.call(parsed), Object.hasOwn(parsed, "b"));
console.log(Object.prototype.hasOwnProperty.call(parsed, "c"));

const copy = { ...parsed };
console.log(copy, Object.getPrototypeOf(copy) === Object.prototype, String(copy));

parsed.added = "yes";
delete parsed.a;
console.log(parsed, parsed.b, parsed.added);
