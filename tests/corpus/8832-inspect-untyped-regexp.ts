// A RegExp held as an untyped value prints its pattern and flags wherever
// the inspector meets it, at any depth, as Node's util.inspect does.
import { format, inspect } from "node:util";

const re: unknown = /re+/g;
console.log(re);
console.log([re, /x/], { r: re });
console.log({ a: { b: { c: { d: re } } } }, { a: { b: { c: re } } });
console.log(inspect(re), inspect({ r: re }, { depth: 0 }));
const spec: string = process.argv.length > 99 ? "" : "%s %O";
console.log(format(spec, re, re));
const escaped: unknown = /a\/b[/]"'\n/giy;
console.log(escaped, [escaped]);
const constructed: unknown = new RegExp("a+", "u");
console.log(constructed);
console.log(new Map<unknown, unknown>([[re, re]]), new Set<unknown>([re]));
const list: unknown[] = [/a/, /b/i];
list.forEach((value) => console.log(value));
console.error(re);
console.log(String(re), `${re}`);
