function collect(input: string, separator: string, limit: number): string {
  let result = "";
  for (const piece of input.split(separator, limit)) result += "[" + piece + "]";
  return result;
}

for (const limit of [0, 1, 2, 7, -1, 1.9, NaN, Infinity, 4294967296, 4294967297]) {
  console.log("limit", limit, collect(",a,,b,", ",", limit));
}
console.log("empty", collect("", "", 9), collect("", ",", 9));
console.log("overlap", collect("ababa", "aba", 9));
console.log("unicode", collect("é世界é中é", "é", 9), collect("世界", "", 9));
console.log("zero", collect("a\0b\0", "\0", 9));

function snapshot(): string {
  let input = "left,right";
  let separator = ",";
  let limit = 2;
  const pieces = input.split(separator, limit);
  input += ",changed";
  separator += "changed";
  limit = 0;
  let result = "";
  for (let pass = 0; pass < 3; pass++) {
    for (const piece of pieces) result += "[" + piece + "]";
  }
  return result + ":" + input + ":" + separator + ":" + limit;
}
console.log("snapshot", snapshot());

let receiver = "first,second";
let effects = "";
function source(): string { effects += "s"; return receiver; }
function separator(): string { effects += "p"; receiver += ",late"; return ","; }
function limit(): number { effects += "l"; return 2; }
let evaluated = "";
for (const piece of source().split(separator(), limit())) {
  receiver += ",body";
  evaluated += "[" + piece + "]";
}
console.log("order", effects, evaluated, receiver);

function failingSeparator(): string { throw new Error("separator"); }
function failingLimit(): number { throw new Error("limit"); }
try {
  for (const piece of (receiver + ",temporary").split(failingSeparator())) console.log(piece);
} catch (error) { console.log("argument", (error as Error).message); }
try {
  for (const piece of (receiver + ",temporary").split(receiver + ",separator", failingLimit())) console.log(piece);
} catch (error) { console.log("argument", (error as Error).message); }

function bindings(): string {
  const readers: (() => string)[] = [];
  for (let piece of "first-word,second-word,third-word".split(",")) {
    piece += "!";
    readers.push(() => piece);
  }
  let result = "";
  for (const read of readers) result += read();
  const shared: (() => string)[] = [];
  for (var piece of "four,five".split(",")) shared.push(() => piece);
  for (const read of shared) result += read();
  let existing = "unchanged";
  for (existing of "six,seven".split(",")) result += existing;
  result += existing;
  for (const [first, second = "_"] of "ab,c".split(",")) result += first + second;
  return result;
}
console.log("bindings", bindings());

function exits(input: string): string {
  const pieces = input.split(",");
  let result = "";
  outer: for (const piece of pieces) {
    try {
      for (const inner of "a,b,c".split(",")) {
        if (inner === "a") continue;
        if (piece === "break") break outer;
        if (piece === "return") return result;
        if (piece === "throw") throw new Error("stop");
        result += piece + inner;
        break;
      }
    } finally { result += "!"; }
  }
  return result;
}
console.log("break", exits("one,break,three"));
console.log("return", exits("one,return,three"));
try { console.log(exits("one,throw,three")); } catch (error) { console.log("throw", (error as Error).message); }

function observable(): string {
  const pieces = "one,two".split(",");
  const alias = pieces;
  alias.push("three");
  let result = "";
  for (const piece of pieces) {
    result += piece;
    if (piece === "one") pieces.push("four");
  }
  return result + ":" + pieces.length;
}
console.log("observable", observable());

function escapes(): string {
  const pieces = "one,two".split(",");
  const read = (): string => pieces.join("/");
  let result = "";
  for (const piece of pieces) result += piece;
  return result + ":" + read();
}
console.log("escapes", escapes());

async function suspended(): Promise<string> {
  let input = "one,two";
  const pieces = input.split(",");
  input += ",late";
  let result = "";
  for (const piece of pieces) {
    await Promise.resolve();
    result += piece;
  }
  for await (const piece of "three,four".split(",")) result += piece;
  return result;
}
suspended().then((value) => console.log("async", value));

function* generator(): Generator<string> {
  for (const piece of "one,two".split(",")) yield piece;
}
for (const piece of generator()) console.log("generator", piece);

function keyedPieces(input: string, separator: string): string {
  const values = new Map<string, string>();
  values.set("first-word", "present");
  values.set("", "empty");
  const saved: string[] = [];
  let result = "";
  for (const key of input.split(separator, 7)) {
    const before = values.get(key);
    if (before === undefined) values.set(key, key + "!");
    saved.push(key);
    const after = values.get(key);
    values.clear();
    result += String(before) + ":" + String(after) + ";";
  }
  return result + saved.join("/");
}
console.log("keys", keyedPieces("first-word,,new-word,first-word,", ","));
console.log("key-unicode", keyedPieces("é世界é中é", "é"), keyedPieces("世界", ""));
console.log("key-zero", keyedPieces("a\0b\0", "\0"));

function keyExits(input: string): string {
  const flags = new Map<string, boolean>();
  flags.set("next", false);
  flags.set("stop", true);
  let result = "";
  outer: for (const key of input.split(",")) {
    try {
      const flag = flags.get(key);
      if (flag === false) continue outer;
      if (flag === true) break outer;
      if (key === "throw") throw new Error("key");
      result += key;
    } finally { result += "[" + key + "]"; }
  }
  return result;
}
console.log("key-exits", keyExits("one,next,stop,last"));
try { keyExits("one,throw,last"); } catch (error) { console.log("key-throw", (error as Error).message); }

const counts = new Map<string, number>();
counts.set("one", 1);
counts.set("two", 2);
let keySum = 0;
const keyReaders: (() => string)[] = [];
for (const key of "one,two,missing".split(",")) {
  keySum += counts.get(key) ?? 0;
  keyReaders.push(() => key);
}
for (let key of "one,two".split(",")) {
  keySum += counts.get(key) ?? 0;
  key += "changed";
  console.log("key-write", key, counts.get(key));
}
console.log("key-captures", keySum, keyReaders.map((read) => read()).join("/"));

const optionalValues = new Map<string, string | undefined>();
optionalValues.set("present", undefined);
optionalValues.set("text", "value");
for (const key of "present,missing,text".split(",")) {
  console.log("key-optional", optionalValues.get(key));
}
