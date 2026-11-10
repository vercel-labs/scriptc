// Byte strings of every prefix shape are keys of Sets and Maps that also
// hold `null` and `undefined`: every key is a key of its own in every
// operation, and it comes out as the string that went in.
//
// A child process's output is copied byte for byte, so `raws` start with
// the raw byte 0xFF (octal 377), which no string of text holds; Node
// decodes each such byte as U+FFFD instead (the constructor's fault is
// queued as raw-bytes-strings). The strings are pairwise distinct either
// way, and only facts that do not depend on the decoding are printed: a
// key's position in `keys`, counts and answers.
import { execSync } from "node:child_process";

const raws = execSync(
  "printf '\\377\\n\\377\\377\\n\\377n\\n\\377u\\n\\377\\377n\\n\\377\\377u\\n\\377\\377\\377n\\n\\377plain\\na\\377n\\n'",
  { encoding: "utf8" },
).split("\n");
raws.pop();
const one = raws[0]!;
// Text that holds U+00FF or a code point near the end of a range has no
// 0xFF byte and is stored as it is.
const text = ["", "n", "u", "plain", "ÿ", "ÿn", "ÿu", "ÿÿ", "nÿ", "߿", "￿", "\u{10ffff}"];
const keys: string[] = [...text, ...raws, one.repeat(40), one.repeat(41) + "n"];
const order: number[] = [];
for (let i = 0; i < keys.length; i++) order.push((i * 7) % keys.length);

function at(key: string | null | undefined): string {
  if (key === null) return "N";
  if (key === undefined) return "U";
  const index = keys.indexOf(key);
  return index < 0 ? "?" : String(index);
}
function bits(answers: boolean[]): string {
  return answers.map((answer) => (answer ? "1" : "0")).join("");
}

console.log(keys.length, new Set(keys).size, one + "n" === raws[2], one + one === raws[1], raws.length);
console.log(text.map((s) => s.length + ":" + (s.length > 0 ? s.charCodeAt(0) : -1)).join(" "));

// A Set of string | null: add, has, size, order, delete, clear.
const ns = new Set<string | null>();
for (const i of order) {
  ns.add(keys[i]!);
  if (i === 5) ns.add(null);
}
console.log("ns", ns.size, ns.has(null), bits(keys.map((k) => ns.has(k))));
console.log([...ns].map(at).join(" "));
console.log(Array.from(ns).map(at).join(" "), Array.from(ns, (k) => at(k)).length);
const seen: string[] = [];
for (const k of ns) seen.push(at(k));
ns.forEach((k, again) => seen.push(at(k) + (k === again ? "" : "!")));
for (const k of ns.keys()) seen.push(at(k));
for (const k of ns.values()) seen.push(at(k));
for (const [k, again] of ns.entries()) seen.push(at(k) + (k === again ? "" : "!"));
console.log(seen.join(" "));
const byHand = ns.values();
let step = byHand.next();
let handed = "";
while (!step.done) {
  handed += at(step.value) + ",";
  step = byHand.next();
}
console.log(handed);

// Every key alone is missing from a Set that holds all the others.
function setsLeaveOneOut(): string {
  let marks = "";
  for (let skip = 0; skip <= keys.length + 1; skip++) {
    const s = new Set<string | null | undefined>();
    for (let i = 0; i < keys.length; i++) if (i !== skip) s.add(keys[i]!);
    if (skip !== keys.length) s.add(null);
    if (skip !== keys.length + 1) s.add(undefined);
    let ok = s.size === keys.length + 1;
    for (let i = 0; i < keys.length; i++) if (s.has(keys[i]!) !== (i !== skip)) ok = false;
    if (s.has(null) !== (skip !== keys.length)) ok = false;
    if (s.has(undefined) !== (skip !== keys.length + 1)) ok = false;
    marks += ok ? "." : "X";
  }
  return marks;
}
console.log(setsLeaveOneOut());

const removed: string[] = [];
for (const i of order) {
  const k = keys[i]!;
  if (i % 2 === 0) removed.push(bits([ns.delete(k), ns.has(k), ns.delete(k)]) + ns.size);
}
console.log(removed.join(" "), bits(keys.map((k) => ns.has(k))), ns.has(null));
console.log([...ns].map(at).join(" "));
for (const i of order) if (i % 2 === 0) ns.add(keys[i]!);
console.log(ns.delete(null), ns.delete(null), ns.has(null), ns.size, [...ns].map(at).join(" "));
ns.add(null);
ns.clear();
console.log(ns.size, ns.has(null), bits(keys.map((k) => ns.has(k))), [...ns].length);
for (const k of keys) ns.add(k);
ns.add(null);
for (const k of keys) ns.add(k);
console.log(ns.size, [...ns].map(at).join(" "));

// A Map of string | null | undefined: set, get, has, order, delete, clear.
const bm = new Map<string | null | undefined, number>();
for (const i of order) {
  bm.set(keys[i]!, i);
  if (i === 3) bm.set(undefined, -2);
  if (i === 9) bm.set(null, -1);
}
console.log("bm", bm.size, bm.get(null), bm.get(undefined), bits(keys.map((k, i) => bm.has(k) && bm.get(k) === i)));
for (const k of keys) bm.set(k, (bm.get(k) ?? 0) + 100);
bm.set(null, 99);
const pairs: string[] = [];
for (const [k, v] of bm) pairs.push(at(k) + "=" + v);
console.log(pairs.join(" "));
const walked: string[] = [];
bm.forEach((v, k) => walked.push(at(k) + "=" + v));
for (const k of bm.keys()) walked.push(at(k));
for (const v of bm.values()) walked.push(String(v));
for (const [k, v] of bm.entries()) walked.push(at(k) + "=" + v);
console.log(walked.join(" "));
console.log([...bm].map(([k, v]) => at(k) + v).join(" "));
console.log([...bm.keys()].map(at).join(" "), Array.from(bm.keys()).length, Array.from(bm).length);
console.log(Array.from(bm, ([k]) => at(k)).join(" "), [...bm.entries()].length, [...bm.values()].length);

function mapsLeaveOneOut(): string {
  let marks = "";
  for (let skip = 0; skip <= keys.length + 1; skip++) {
    const m = new Map<string | null | undefined, number>();
    for (let i = 0; i < keys.length; i++) if (i !== skip) m.set(keys[i]!, i);
    if (skip !== keys.length) m.set(null, keys.length);
    if (skip !== keys.length + 1) m.set(undefined, keys.length + 1);
    let ok = m.size === keys.length + 1;
    for (let i = 0; i < keys.length; i++) if (m.get(keys[i]!) !== (i !== skip ? i : undefined)) ok = false;
    if (m.get(null) !== (skip !== keys.length ? keys.length : undefined)) ok = false;
    if (m.has(undefined) !== (skip !== keys.length + 1)) ok = false;
    marks += ok ? "." : "X";
  }
  return marks;
}
console.log(mapsLeaveOneOut());

const dropped: string[] = [];
for (const i of order) {
  const k = keys[i]!;
  if (i % 3 !== 0) dropped.push(bits([bm.delete(k), bm.has(k), bm.delete(k)]) + (bm.get(k) ?? "-") + bm.size);
}
console.log(dropped.join(" "));
console.log(bm.delete(undefined), bm.delete(undefined), bm.has(undefined), bm.get(null), [...bm.keys()].map(at).join(" "));
bm.clear();
console.log(bm.size, bm.has(null), bm.has(undefined), bits(keys.map((k) => bm.has(k))), [...bm].length);
for (const i of order) bm.set(keys[i]!, i);
bm.set(undefined, 1).set(null, 2);
console.log(bm.size, [...bm.keys()].map(at).join(" "));

// The other key unions.
const us = new Set<string | undefined>([undefined, ...keys]);
const nm = new Map<string | null, string>([[null, "N"]]);
const um = new Map<string | undefined, string>();
for (const i of order) {
  nm.set(keys[i]!, at(keys[i]!));
  um.set(keys[i]!, at(keys[i]!));
  if (i === 1) um.set(undefined, "U");
}
console.log(us.size, us.has(undefined), bits(keys.map((k) => us.has(k))), [...us].map(at).join(" "));
console.log(nm.size, nm.get(null), bits(keys.map((k) => nm.get(k) === at(k))), [...nm.keys()].map(at).join(" "));
console.log(um.size, um.get(undefined), bits(keys.map((k) => um.get(k) === at(k))), [...um.values()].join(" "));
console.log(bits(keys.map((k) => us.delete(k) && nm.delete(k) && um.delete(k))), us.size, nm.size, um.size);
console.log([...us].map(at).join(""), [...nm.keys()].map(at).join(""), [...um.keys()].map(at).join(""));

// Copies into a collection of another key type.
for (const k of keys) {
  us.add(k);
  nm.set(k, at(k));
}
const wider = new Set<string | null | undefined>([...ns]);
wider.add(undefined);
const strings = new Set<string>();
for (const k of ns) if (k !== null) strings.add(k);
const back = new Set<string | null>([...strings]);
const swapped = new Set<string | undefined>([...ns].map((k) => (k === null ? undefined : k)));
const fromKeys = new Set(bm.keys());
const plain = new Map<string, number>();
for (const [k, v] of bm) if (k !== null && k !== undefined) plain.set(k, v);
const again = new Map<string | null, number>([...plain]);
console.log(wider.size, strings.size, back.size, swapped.size, fromKeys.size, plain.size, again.size);
console.log(bits(keys.map((k) => wider.has(k) && strings.has(k) && back.has(k) && swapped.has(k) && fromKeys.has(k))));
console.log(bits(keys.map((k, i) => plain.get(k) === i && again.get(k) === i)), again.has(null), back.has(null));
console.log([...wider].map(at).join(" "), [...swapped].map(at).join(" "));
console.log([...back].map(at).join(" "), [...fromKeys].map(at).join(" "));
const sameType = new Set(ns);
const sameMap = new Map(bm);
const fromPairs = new Map([...bm]);
const ofValues = new Set(nm.values());
console.log(sameType.size, sameMap.size, fromPairs.size, ofValues.size, [...sameType].map(at).join(" "));
console.log([...sameMap.keys()].map(at).join(" "), bits(keys.map((k, i) => fromPairs.get(k) === i)));

// The Set methods and Map.groupBy.
const evens = new Set<string | null>([null]);
const thirds = new Set<string | null>();
keys.forEach((k, i) => {
  if (i % 2 === 0) evens.add(k);
  if (i % 3 === 0) thirds.add(k);
});
console.log([...evens.union(thirds)].map(at).join(" "), [...evens.intersection(thirds)].map(at).join(" "));
console.log([...evens.difference(thirds)].map(at).join(" "), [...evens.symmetricDifference(thirds)].map(at).join(" "));
console.log(evens.isSubsetOf(ns), thirds.isSupersetOf(evens), evens.isDisjointFrom(thirds), ns.isSupersetOf(thirds));
const groups = Map.groupBy(order, (i): string | null => (i % 5 === 0 ? null : keys[i - (i % 2)]!));
const grouped: string[] = [];
for (const [k, members] of groups) grouped.push(at(k) + ":" + members.join("+"));
console.log(groups.size, grouped.join(" "));

// Behind `unknown`: the collection's own operations table.
const view: unknown = ns;
if (view instanceof Set) {
  const found: string[] = [];
  for (const k of view) found.push(typeof k === "string" ? at(k) : k === null ? "N" : "?");
  console.log(view.size, view.has(null), bits(keys.map((k) => view.has(k))), found.join(" "));
  console.log(bits(keys.map((k) => view.delete(k))), view.size, bits(keys.map((k) => ns.has(k))), ns.has(null));
  for (const i of order) view.add(keys[i]);
  view.forEach((k) => found.push(typeof k === "string" ? at(k) : "N"));
  console.log(view.size, [...ns].map(at).join(" "), found.length, [...view].length);
}
const mapView: unknown = bm;
if (mapView instanceof Map) {
  console.log(mapView.size, mapView.get(null), mapView.get(undefined), bits(keys.map((k, i) => mapView.get(k) === i)));
  console.log(bits(keys.map((k, i) => i % 2 === 0 && mapView.delete(k))), mapView.size, bits(keys.map((k) => bm.has(k))));
  for (const i of order) mapView.set(keys[i], i * 2);
  const found: string[] = [];
  for (const [k, v] of mapView) found.push((typeof k === "string" ? at(k) : k === null ? "N" : "U") + "=" + v);
  console.log(found.join(" "), bits(keys.map((k, i) => bm.get(k) === i * 2)));
}
const cloned = structuredClone(ns);
const clonedMap = structuredClone(bm);
console.log(cloned.size, cloned.has(null), [...cloned].map(at).join(" "));
console.log(clonedMap.size, clonedMap.get(null), [...clonedMap].map(([k, v]) => at(k) + "=" + v).join(" "));

// A generic function reads and writes every kind through its parameter.
function roundTrip<K extends string | null | undefined>(label: string, items: K[]): void {
  const set = new Set<K>();
  const map = new Map<K, number>();
  items.forEach((item, i) => {
    set.add(item);
    map.set(item, i);
  });
  let ok = set.size === items.length && map.size === items.length;
  items.forEach((item, i) => {
    if (!set.has(item) || map.get(item) !== i) ok = false;
  });
  const out = [...set];
  const outKeys = [...map.keys()];
  items.forEach((item, i) => {
    if (out[i] !== item || outKeys[i] !== item) ok = false;
  });
  for (const item of items) if (!set.delete(item) || set.has(item) || !map.delete(item)) ok = false;
  console.log(label, ok, set.size, map.size, out.map(at).join(" "));
}
roundTrip<string | null>("null", [...keys, null]);
roundTrip<string | undefined>("undefined", [undefined, ...keys]);
roundTrip<string | null | undefined>("both", [null, ...keys, undefined]);
roundTrip<string>("string", keys);
