// One constructor held alone, declared and inferred, handed to the same kind
// of consumers as a table of several: an assertion on identity, `in`, key
// listing, JSON, an optional call.
import { strictEqual } from "node:assert";
import { format } from "node:util";

const parse: typeof Number = Number;
const show = String;
const flags: Record<string, typeof Boolean> = { on: Boolean, off: Boolean };

strictEqual(parse, Number);
strictEqual(show, String);
console.log("name" in parse, Object.keys(parse).length, parse("4") + 1);
console.log(JSON.stringify({ p: parse, n: 1 }), JSON.stringify([show, 1]), format("%j", flags));
console.log(flags.on?.("x"), flags.off === Boolean, Object.keys(flags).join(","));
console.log(typeof parse, parse.name, show.length, show(12) + "!", parse === Number);
