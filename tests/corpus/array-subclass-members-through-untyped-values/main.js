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

// A member read through a variable key, after an `in` guard.
function byName(value, name, ...args) {
  if (!(name in value)) return name + " absent";
  const member = value[name];
  return typeof member === "function" ? member.apply(value, args) : member;
}
console.log(byName(held, "describe", "k"), byName(held, "size"), byName(held, "label"), byName(held, "nope"));
console.log(byName(held, "refresh", "r1", "r2") === held, held.join(","));

// Writes through a variable key reach the field or the setter.
function setByName(value, name, v) {
  value[name] = v;
}
setByName(held, "label", "W");
setByName(held, "size", 0);
console.log(held.label, a.label, held.size, a.length, byName(held, "label"));

// A frozen instance's fields are read-only: module code is strict, so each
// write throws Node's TypeError and leaves the field as it was.
const frozen = new Listy();
Object.freeze(frozen);
for (const write of [
  () => {
    [frozen][0].label = "named";
  },
  () => setByName(frozen, "label", "keyed"),
  () => {
    frozen.label = "typed";
  },
]) {
  try {
    write();
    console.log("wrote", frozen.label);
  } catch (e) {
    console.log(String(e), frozen.label);
  }
}

// Frozen through an untyped parameter: the same writes throw.
function freezeUntyped(value) {
  Object.freeze(value);
}
const frozenLater = new Listy();
freezeUntyped([frozenLater][0]);
for (const write of [
  () => setByName(frozenLater, "label", "keyed"),
  () => setByName(frozenLater, "size", 0),
  () => {
    [frozenLater][0].label = "named";
  },
]) {
  try {
    write();
    console.log("wrote", frozenLater.label);
  } catch (e) {
    console.log(String(e), frozenLater.label);
  }
}

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
