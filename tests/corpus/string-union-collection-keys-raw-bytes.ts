// A string that is not text (a child process wrote the bytes FF 6E and
// FF 75) is a key of its own in a Set and a Map that also hold `null` and
// `undefined`: it is never the unit key, in any operation. Only facts that
// do not depend on how the bytes were decoded are printed.
import { execSync } from "node:child_process";

const rawN = execSync("printf '\\377n'", { encoding: "utf8" });
const rawU = execSync("printf '\\377u'", { encoding: "utf8" });
const rawOnly = execSync("printf '\\377'", { encoding: "utf8" });
const rawTwice = execSync("printf '\\377\\377n'", { encoding: "utf8" });
const raws = [rawN, rawU, rawOnly, rawTwice];

const nulls = new Set<string | null>([null, "plain"]);
const undefs = new Set<string | undefined>([undefined, "plain"]);
const both = new Map<string | null | undefined, number>([
  [null, 1],
  [undefined, 2],
]);
console.log(raws.map((s) => nulls.has(s)).join(","), raws.map((s) => undefs.has(s)).join(","));
console.log(raws.map((s) => both.has(s)).join(","), raws.map((s) => both.get(s) === undefined).join(","));

for (const s of raws) {
  nulls.add(s);
  undefs.add(s);
  both.set(s, 10);
}
console.log(nulls.size, undefs.size, both.size, both.get(null), both.get(undefined), both.get(rawN));
console.log(raws.map((s) => nulls.has(s) && undefs.has(s) && both.has(s)).join(","));

function count<K>(keys: Iterable<K>, same: K[]): string {
  let units = 0,
    strings = 0,
    found = 0;
  for (const k of keys) {
    if (k === null || k === undefined) units++;
    else strings++;
    if (same.includes(k)) found++;
  }
  return units + "/" + strings + "/" + found;
}
console.log(count(nulls, raws), count(undefs, raws), count(both.keys(), raws));
console.log(count([...nulls], raws), count(Array.from(undefs), raws), count([...both.keys()], raws));

const view: unknown = nulls;
if (view instanceof Set) {
  console.log(view.size, view.has(null), raws.map((s) => view.has(s)).join(","));
  let units = 0;
  for (const k of view) if (k === null) units++;
  console.log(units, view.delete(rawN), view.has(rawN), view.has(null));
  view.add(rawN);
}
const copy = new Set(nulls);
const fromKeys = new Set(both.keys());
console.log(copy.size, raws.map((s) => copy.has(s)).join(","), fromKeys.size, fromKeys.has(null), fromKeys.has(rawU));

for (const s of raws) {
  console.log(nulls.delete(s), undefs.delete(s), both.delete(s), nulls.has(null), undefs.has(undefined), both.size);
}
console.log(nulls.delete(null), undefs.delete(undefined), both.delete(null), both.delete(undefined));
console.log(nulls.size, undefs.size, both.size);
