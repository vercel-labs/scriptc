// node:querystring with values whose types are known only at run time, as
// lib/querystring.js takes them: escape converts its argument, parse answers
// an empty object for a query that is not a string, maxKeys counts only when
// it is a number, separators follow the falsy rule and String(value), and
// stringify takes any object (arrays by index) with the custom encoder and
// decoder options. unescapeBuffer answers the raw bytes.
import qs from "node:querystring";
import assert from "node:assert";

function attempt(label, fn) {
  try {
    console.log(label, JSON.stringify(fn()));
  } catch (e) {
    console.log(label, e.name, e.code, e.message);
  }
}

const show = (parsed) => JSON.stringify(Object.entries(parsed));

// escape: String(value) for objects and null, value + "" otherwise.
for (const value of [5, -0, true, null, undefined, 10n, [5, 10], {}, { toString: () => "a b" }]) {
  attempt(`escape ${typeof value}`, () => qs.escape(value));
}
attempt("escape valueOf", () => qs.escape({ toString: 5, valueOf: () => "v&w" }));
attempt("escape no primitive", () => qs.escape({ toString: 5 }));
attempt("escape symbol", () => qs.escape(Symbol("s")));

// parse: a query that is not a string answers an empty object.
for (const query of [undefined, null, 5, ["a=b"], { a: 1 }]) {
  console.log("parse", typeof query, show(qs.parse(query)));
}
console.log("parse none", show(qs.parse()));

// maxKeys counts only when it is a number.
const many = Array.from({ length: 1200 }, (_, i) => `k${i}=${i}`).join("&");
for (const maxKeys of [2, 0, -1, Infinity, NaN, "2", "Infinity", null]) {
  console.log("maxKeys", String(maxKeys), Object.keys(qs.parse(many, null, null, { maxKeys })).length);
}

// Separators: falsy values are the defaults, others are String(value).
const seps = ["", 0, false, null, ";", 5, ["&"], []];
seps.forEach((sep, i) => console.log("sep", i, show(qs.parse("a=1&b5=2;c=3", sep))));
const eqs = ["", 0, ":", [], ["="]];
eqs.forEach((eq, i) => console.log("eq", i, show(qs.parse("a=1&b:2", null, eq))));
console.log("stringify sep", qs.stringify({ a: 1, b: 2 }, 0, ""), qs.stringify({ a: 1, b: 2 }, 7, 8));

// stringify: arrays stringify by index; other values that are not objects are "".
console.log("stringify", qs.stringify([0n, 1n, "x y"]), qs.stringify([[1, 2], , "z"]));
for (const value of [0, true, "a=b", null, undefined, 5n]) {
  console.log("stringify", typeof value, JSON.stringify(qs.stringify(value)));
}

// Custom encodeURIComponent: each key once, then its values, in order.
const calls = [];
const encoded = qs.stringify({ a: [1, "x"], b: [], c: true, d: NaN, e: 2n }, null, null, {
  encodeURIComponent: (text) => {
    calls.push(text);
    return text.toUpperCase();
  },
});
console.log("encode", encoded, JSON.stringify(calls));
console.log("encode numbers", qs.stringify({ n: 1 }, null, null, { encodeURIComponent: (text) => text.length }));
console.log("encode not a function", qs.stringify({ a: "x y" }, null, null, { encodeURIComponent: 5 }));
attempt("encode throws", () =>
  qs.stringify({ a: 1 }, null, null, {
    encodeURIComponent: () => {
      throw new Error("encoder failed");
    },
  }),
);

// Custom decodeURIComponent: every non-empty key and value, '+' as "%20";
// a decoder that throws falls back to unescape(s, true).
const decoded = [];
const parsed = qs.parse("a+b=c%20d&e=&=f&g=h+i", null, null, {
  decodeURIComponent: (text) => {
    decoded.push(text);
    return text.replace(/%20/g, "_");
  },
});
console.log("decode", show(parsed), JSON.stringify(decoded));
console.log(
  "decode throws",
  show(
    qs.parse("a%20b=c+d&e%zz=1", null, null, {
      decodeURIComponent: () => {
        throw new Error("decoder failed");
      },
    }),
  ),
);
console.log("decode not a function", show(qs.parse("a%20b=c+d", null, null, { decodeURIComponent: 1 })));

// unescapeBuffer: the bytes of the scan, '+' as a space when asked.
console.log(qs.unescapeBuffer("a+b%20c%"), qs.unescapeBuffer("a+b%41", true), qs.unescapeBuffer("Ā%2"));
console.log(qs.unescapeBuffer("x+y", 1).toString(), Buffer.isBuffer(qs.unescapeBuffer("")));

// strictEqual of the parsed union against a string.
const result = qs.parse("id=7&id=8&one=1");
assert.strictEqual(result.one, "1");
assert.notStrictEqual(result.id, "7");
attempt("strictEqual array", () => assert.strictEqual(result.id, "7"));
