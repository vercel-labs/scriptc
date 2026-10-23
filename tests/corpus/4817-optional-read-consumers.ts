// Reads that may miss reach consumers that convert undefined: promises keep
// their payload's identity when an async result drops the undefined arm,
// `new Date` makes an invalid date of a missing number, and a conditional's
// condition proves its true branch's read present.
import { isBuiltin } from "node:module";

type Point = { x: number; y: number };
type Named = { name: string };
type Item = Point | Named;
const items: Item[] = [{ x: 1, y: 2 }, { name: "a" }, { x: 3, y: 4 }];

async function load(i: number): Promise<Item> {
  await null;
  return items[i % items.length];
}

async function promises(): Promise<void> {
  const one = await load(0);
  const pending: Promise<Item>[] = [load(2), load(0)];
  const all = await Promise.all(pending);
  const raced = await Promise.race([load(1), new Promise<Item>((r) => setTimeout(() => r(items[0]), 5))]);
  console.log(one === items[0], all[0] === items[2], all[1] === items[0], raced === items[1]);
}

const times: number[] = [0, 86400000];
const at = process.argv.length - 1;
const past = at + 5;
console.log(new Date(times[at]).toISOString(), new Date(times[past]).getTime(), String(new Date(times[past])));

const names: string[] = ["node:fs", "left-pad"];
const first = names.length > 0 ? names[0] : "none";
const third = names.length > 2 ? names[2] : "node:path";
console.log(isBuiltin(first), isBuiltin(third), isBuiltin(names.length > 1 ? names[1] : "x"));

// String reads that may miss, converted to strings: concatenated with a
// string or placed in a template literal a missing element is "undefined";
// two missing elements added together are NaN.
const words: string[] = ["alpha", "beta"];
const gap = names.length + 3;
console.log(words[0] + "-" + words[gap], `${words[gap]}|${words[1]}`, words[gap] + words[gap], " " + words[1]);

void promises();
