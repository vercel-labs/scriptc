// Every way a compiled program trusts a type no build can verify, once
// each: parsed data under an assertion, a value through `any`, a Node
// island's values and a function it calls, and a package compiled from its
// JavaScript. `size` is the counterexample: it tests the value's kind, so
// its read is not a claim.
import { each, label, load, open, started } from "tc-island";
import { width } from "tc-native";

interface Config {
  name: string;
  retries: number;
}

const config = JSON.parse('{"name":"a","retries":2}') as Config;
const other = JSON.parse('{"name":"b","retries":3}') as Config;

const raw: any = JSON.parse("[1,2]");
const first: number = raw[0];
const second: number = raw[1];

function size(value: unknown): number {
  return typeof value === "string" ? value.length : 0;
}

const session = open("x", 30);
const ttl: number = session.ttl;
const doubled = session.ttl * 2;
each(["a", "b"], (item, index) => {
  console.log(item, index);
});
const loaded = load("p") as Loaded;
const when: Date = started();

console.log(config.name, other.retries, first + second, size("q"), ttl, doubled);
console.log(loaded.name, when.getTime(), label(session), width("a"));

// A value the build holds dynamically under a type the source declares is
// not untyped: reading it back is no claim. Asserting a narrower type of
// it is one.
function table(n: number): Record<string, object> {
  return Object.fromEntries([["a", { n }]]);
}
type Catalog = Record<"a", { n: number }>;
const entries = table(1);
const catalog = table(2) as Catalog;
console.log(Object.keys(entries).length, catalog.a.n);

// "Skip a malformed line": the handler ignores the error, so a line that
// parses and lacks a field the type declares is skipped too, unseen.
function readEntry(line: string): Config | null {
  try {
    return JSON.parse(line) as Config;
  } catch {
    return null;
  }
}
console.log(readEntry('{"name":"c"}')?.name);

// A kind test guards only what it dominates: this conversion runs before
// the test, so it is a claim.
function late(value: any): number {
  const n: number = value;
  return typeof value === "number" ? n : 0;
}
console.log(late(3));

// The island's value is read through a type of its own: an assertion applied
// to an island value makes that type a view of the island's object, and
// `Config` stays the type of parsed data alone.
interface Loaded {
  name: string;
  retries: number;
}
