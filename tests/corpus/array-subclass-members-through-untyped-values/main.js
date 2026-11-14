// A class that extends Array keeps its identity and its members when its
// instances reach untyped values: an untyped array of them, an `any`
// parameter, a page script. Calls, getters, setters and field writes go to
// the instance itself.
import { inspect } from "node:util";
import { appendTag, getElementsByTagName } from "./collection.ts";
import { fromTyped } from "./typed.ts";

class Listy extends Array {
  label = "L";
  get size() {
    return this.length;
  }
  set size(n) {
    this.length = n;
  }
  refresh(...items) {
    this.length = 0;
    for (const item of items) this.push(item);
    return this;
  }
  describe(prefix) {
    return prefix + ":" + this.label + ":" + this.join("|");
  }
}

// The original shape: methods called through the array holding them.
var live = [];
live.push(new Listy());
for (var i = 0; i < live.length; i++) live[i].refresh();
console.log("done " + live[0].length);

const a = new Listy();
const b = new Listy();
live.push(a, b);
a.push("x");
for (let i = 1; i < live.length; i++)
  console.log(live[i].refresh("p" + i, "q") === live[i], live[i].length);
console.log(a.join(","), b.join(","));

const held = live[1];
console.log(held === a, held instanceof Listy, Array.isArray(held), held.constructor === Listy);
console.log(held.size, held.describe("d"));
held.size = 1;
console.log(a.length, a.join(","));
held.label = "M";
console.log(a.label, live[1].label, held.describe("e"));
console.log("refresh" in held, "size" in held, "label" in held, "nope" in held);
console.log(typeof held.refresh, typeof held.missing);
console.log(Object.keys(held).join(","), JSON.stringify(held), inspect(held));

function callThrough(value, ...args) {
  return value.refresh(...args).length;
}
console.log(callThrough(b, 1, 2, 3), b.join(","));

// A collection the typed runtime made, used from the page.
const divs = getElementsByTagName();
const seen = divs;
console.log(seen.length, seen.item(1), seen.namedItem("span"), seen.first, seen.refreshes);
appendTag("p");
console.log(seen.length, seen.item(2), divs.join(","), seen.refreshes);
seen.refresh();
console.log(seen.refreshes, divs.refreshes);
console.log("typed", fromTyped());
