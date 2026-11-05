// One island round lowers the program through several passes (reachable
// emit, the whole-slot comparison, the stream relowers, historical order,
// the coverage remainder), and they share the round's program facts: file
// paths, stdlib / external-surface / package classification, symbol
// provenance, island-handle answers, the admitted-opinion index, the
// JavaScript dynamic-declaration set and the class protocol index. Every
// answer below must be the same in every pass, so this program pins what
// each consumer of those facts compiles to: protocol identity for a class
// and for an object literal whose member kinds disagree with its target,
// collection views of Map and Set, stdlib provenance of Map, RegExp and
// Promise, and a JavaScript source in the same round (attributes.cjs), whose
// object-literal types only the checked-dynamic representation holds.
import { createRequire } from "node:module";

interface Attributes {
  describe(label: string): string;
}
const require = createRequire(import.meta.url);
const attributes: Attributes = require("./attributes.cjs");

interface Reader {
  read(): string;
}

interface Sized {
  readonly size: number;
}

// A class implementing interfaces keeps protocol identity: its members are
// invoked through the class's own table, never read from a property bag.
class Parts implements Reader, Sized {
  private readonly items: string[] = [];
  constructor(...items: string[]) {
    this.items.push(...items);
  }
  read(): string {
    return this.items.join("|");
  }
  get size(): number {
    return this.items.length;
  }
}

// An object literal whose getter satisfies a DATA member keeps checked
// identity: the target type is a live view, so Object.keys sees the name and
// JSON.stringify calls the getter, as Node does.
interface ReportShape {
  title: string;
  words: number;
}
function report(): ReportShape {
  return {
    title: "monthly",
    get words(): number {
      return "two words".split(" ").length;
    },
  };
}

// A Map answering a structural view of its members is a collection view: the
// methods run on the collection, and a stored member is never read.
interface Lookup {
  get(key: string): number | undefined;
  has(key: string): boolean;
}
const totals = new Map<string, number>([
  ["a", 1],
  ["b", 2],
]);
const view: Lookup = totals;

// Set keeps its own protocol, and spreading it walks the collection.
const tags = new Set(["x", "y", "x"]);

// Stdlib provenance decides that these are the library's own classes, not
// records the program declares.
const epoch = new Date(0);
const pattern = new RegExp("([a-z]+)-(\\d+)");
const match = "item-42".match(pattern);
const promise = Promise.resolve(7);

const parts = new Parts("one", "two", "three");
const literal = report();

async function main(): Promise<void> {
  console.log("reader", parts.read(), parts.size);
  console.log("literal", JSON.stringify(literal), Object.keys(literal).join(","));
  console.log("view", view.get("b"), view.has("c"), view.get("a") ?? -1);
  console.log("set", [...tags].join(","), totals.size);
  console.log("date", epoch.toISOString().slice(0, 4), Number.isNaN(epoch.getTime()));
  console.log("match", match === null ? "none" : `${match[1]}:${match[2]}`);
  const all = await Promise.all([promise, Promise.resolve(1)]);
  console.log("promise", await promise, all.join("-"));
  console.log("js", attributes.describe("round"));
  console.log("json", JSON.stringify({ parts: { size: parts.size }, total: totals.get("b") }));
}

void main();
