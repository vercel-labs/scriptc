// node:querystring over its documented surface: parse/decode with repeated
// keys (arrays), empty keys and values, lone keys, empty and separator-only
// input, percent-decoding (invalid and multi-byte), '+' as space, case
// sensitivity, maxKeys (0, negative, NaN), custom decodeURIComponent and
// stringify/encode with arrays, null and undefined, booleans, empty and
// nested objects, numbers (-0, NaN, Infinity), custom separators, custom
// encodeURIComponent, null-prototype and sparse objects, escape/unescape
// over the RFC 3986 set, and a parse/stringify round trip.
import * as qs from "node:querystring";

function shape(fn: () => unknown): string {
  try {
    const value = fn();
    return "ok " + JSON.stringify(value);
  } catch (e) {
    const err = e as Error & { code?: string };
    return "ERR " + err.name + " " + String(err.code) + " " + err.message;
  }
}

const inputs = [
  "a=1&b=2",
  "a=1&a=2&a=3",
  "a",
  "=x",
  "a=",
  "",
  "&&&",
  "a=1&&b=2",
  "a=%E4%B8%96",
  "a=%zz",
  "a=+b+c",
  "a=%2B",
  "A=1&B=2",
  "a[b]=1&a=c",
  "a=1;b=2",
  "a=1|b=2",
  "__proto__=x",
  "constructor=y",
  "a=1&b",
  "=1&=",
];
for (const input of inputs) {
  console.log(
    "parse",
    JSON.stringify(input),
    shape(() => qs.parse(input)),
    shape(() => qs.decode(input)),
    shape(() => qs.parse(input, "&", "=", { maxKeys: 2 })),
    shape(() => qs.parse(input, ";", "=")),
    shape(() => qs.parse(input, "&", "=", { decodeURIComponent: (part: string) => "D" + part })),
  );
}
console.log("maxKeys", shape(() => qs.parse("a=1&b=2", "&", "=", { maxKeys: 0 })), shape(() => qs.parse("a=1&b=2", "&", "=", { maxKeys: -1 })), shape(() => qs.parse("a=1&b=2", "&", "=", { maxKeys: NaN })));
console.log("maxKeys", shape(() => qs.parse("a=1&b=2", "&", "=", { maxKeys: 1.5 })));

type QueryValue = string | number | boolean | null | undefined | (string | number | boolean)[];
const objects: { [key: string]: QueryValue }[] = [
  { a: 1, b: "x" },
  { a: [1, 2, 3] },
  { a: "" },
  { a: null },
  { a: undefined },
  { a: true },
  { a: [] },
  { "k y": "v w", "ü": "ö" },
  { a: 1.5, b: -0, c: NaN, d: Infinity },
  { a: [true] },
];
for (const object of objects) {
  console.log(
    "stringify",
    JSON.stringify(object),
    shape(() => qs.stringify(object)),
    shape(() => qs.encode(object)),
    shape(() => qs.stringify(object, ";", ":")),
    shape(() => qs.stringify(object, "&", "=", { encodeURIComponent: (part: string) => "[" + part + "]" })),
  );
}
const nullProto: { [key: string]: string } = Object.create(null) as { [key: string]: string };
nullProto["a"] = "1";
console.log("null prototype", shape(() => qs.stringify(nullProto)));
console.log("round trip", shape(() => qs.stringify(qs.parse("a=1&b=2&a=3"))));
console.log("escape", shape(() => qs.escape("a b+c/ü'\"<>#")), shape(() => qs.escape("~!*()")));
console.log("unescape", shape(() => qs.unescape("a%20b+c%2F%C3%BC")), shape(() => qs.unescape("%zz")), shape(() => qs.unescape("%E4%B8")), shape(() => qs.unescape("plain")));
console.log("decode exotic", shape(() => qs.unescape("%00%0A%0D")), shape(() => qs.escape("\u0000\n\r")));
console.log("separators", shape(() => qs.parse("a=1&b=2", null as unknown as string, null as unknown as string, { maxKeys: 1 })), shape(() => qs.parse("a=1&b=2", "", "")), shape(() => qs.parse("a=1ü b=2", "ü " as unknown as string, "=")));
console.log("stringify separators", shape(() => qs.stringify({ a: 1 }, "", "")), shape(() => qs.stringify({ a: 1 }, null as unknown as string, null as unknown as string)), shape(() => qs.stringify({ "": "" })));
console.log("astral", shape(() => qs.escape("😀")), shape(() => qs.unescape("%F0%9F%98%80")), shape(() => qs.unescape("%f0%9f%98%80")), shape(() => qs.unescape("%FF")));
