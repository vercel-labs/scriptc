// querystring.stringify writes a bigint value as its decimal digits, bare
// like a boolean (Node's encodeStringified), in plain and array-valued
// fields and under custom separators. url.format's query object follows
// the same rule.
import { encode, stringify } from "node:querystring";
import { format } from "node:url";

console.log(stringify({ a: 1n, b: -2n, c: 0n }));
console.log(stringify({ big: 12345678901234567890n, neg: -(2n ** 70n) }));
console.log(stringify({ list: [1n, "two", 3, true, -4n] }));
console.log(stringify({ a: 5n, b: [6n, 7n] }, ";", ":"));
console.log(encode({ id: 42n, name: "x y" }));

const counts: Record<string, bigint> = { first: 10n, second: 20n };
console.log(stringify(counts));
const mixed: Record<string, bigint | string | null> = { n: 1n, s: "v", z: null };
console.log(stringify(mixed));

console.log(format({ protocol: "https", host: "example.test", pathname: "/p", query: { id: 99n, tag: ["a", 2n] } }));
