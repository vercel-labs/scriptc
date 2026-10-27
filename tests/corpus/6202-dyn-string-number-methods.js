// String and Number methods on JS-inferred receivers: string receivers run
// the real method (string-width's codePointAt, camelcase's
// toLocaleLowerCase, toml's substr, pretty-bytes' toPrecision); other
// receivers keep JavaScript's answer for the name, an object's own method
// or Node's TypeError; arrays keep the runtime dispatch of shared names.
function width(text) {
  let total = 0;
  for (const character of text) {
    const code = character.codePointAt(0);
    total += code >= 0x1100 ? 2 : 1;
  }
  return total;
}
console.log(width("abc"), width("古"), width("👍x"));

function describe(input) {
  return [
    input.codePointAt(0),
    input.codePointAt(-1),
    input.codePointAt("1"),
    input.substr(1),
    input.substr(-2, 1),
    input.toLocaleLowerCase(),
    input.toLocaleUpperCase("en-US"),
    input.toLocaleLowerCase("tr"),
    input.trimLeft(),
    input.trimRight(),
    input.isWellFormed(),
    input.toWellFormed().length,
  ];
}
console.log(JSON.stringify(describe("  Iİ😀 ")));
console.log(JSON.stringify(describe("\ud800Ab")));
const parsed = JSON.parse('["  I\\u0130\\ud83d\\ude00 ", 1337, 0.000123456, [1, 2, 3]]');
console.log(JSON.stringify(describe(parsed[0])));

function number(value, digits) {
  return [value.toPrecision(digits), value.toExponential(digits), value.toPrecision()];
}
console.log(JSON.stringify(number(1337, 3)), JSON.stringify(number(0.000123456, 2)));
console.log(JSON.stringify(number(-1.5, "4")), JSON.stringify(number(2.5, undefined)));
console.log(JSON.stringify(number(parsed[1], 3)), JSON.stringify(number(parsed[2], parsed[1] - 1335)));

function prettyBytes(n) {
  const units = ["B", "kB", "MB", "GB"];
  const exponent = Math.min(Math.floor(Math.log10(n) / 3), units.length - 1);
  return Number((n / 1000 ** exponent).toPrecision(3)) + " " + units[exponent];
}
console.log(prettyBytes(1337), prettyBytes(100), prettyBytes(12345678));

const own = { codePointAt(i) { return "own " + i; }, substr() { return "own substr"; }, toPrecision(d) { return "own " + d; } };
console.log(describeOwn(own));
function describeOwn(value) {
  return [value.codePointAt(3), value.substr(), value.toPrecision(2)].join("|");
}
function arrays(list) {
  return JSON.stringify([list.at(-1), list.concat([4], 5)]);
}
console.log(arrays([1, 2, 3]), arrays(parsed[3]));

function attempt(f) {
  try {
    return String(f());
  } catch (e) {
    return e.name + ": " + e.message;
  }
}
function fail(value) {
  return [
    attempt(() => value.codePointAt(0)),
    attempt(() => value.substr(0)),
    attempt(() => value.toPrecision(2)),
    attempt(() => value.toLocaleLowerCase()),
  ].join(" / ");
}
for (const value of [42, "str", undefined, null, {}, parsed[3]]) console.log(fail(value));
for (const value of JSON.parse('[42, "str", null, {}, true]')) console.log(fail(value));
console.log(attempt(() => number(1, 200)));
console.log(attempt(() => "x".toLocaleUpperCase(null)));

// A helper whose parameter the checker leaves untyped answers `string |
// undefined` natively; the guarded receiver still runs String methods.
function afterX(segment) {
  const index = segment.indexOf("x");
  return index === -1 ? undefined : segment.slice(index + 1);
}
function tailCode(text) {
  const rest = afterX(text);
  if (rest === undefined) return -1;
  return [rest.codePointAt(0), rest.substr(1), rest.toUpperCase(), rest.slice(1)].join(",");
}
console.log(tailCode("axé😀"), tailCode("abc"));

// The arguments convert after all of them evaluate: a toString or valueOf
// that assigns a variable leaves an argument already read from it as it was.
let later = "a";
const shout = {
  toString() {
    later = "b";
    return "o";
  },
};
console.log("s".concat(shout, later), later);
let at = 1;
const move = {
  valueOf() {
    at = 3;
    return 0;
  },
};
console.log("abcdef".substr(move, at), at);
