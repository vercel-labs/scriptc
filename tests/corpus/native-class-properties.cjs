"use strict";
// An opaque field does not prevent reading or updating the other properties
// of the same native instance through an untyped package boundary.
class Base {
  cache = new Map();
  width = 40;
  child = { value: 1 };
  events = [];
  get size() {
    this.events.push("get");
    return this.width * 2;
  }
  set size(value) {
    this.events.push("set");
    this.width = value / 2;
  }
}
class Renderer extends Base {
  height = 24;
  get label() { return `size:${this.width}`; }
}
const renderer = new Renderer();
renderer.cache.set("kept", 7);
const view = /** @type {unknown} */ (renderer);
console.log("dimensions", view.width, view.height, view.size, view.label);
view.width = 60;
view.size = 160;
console.log("updates", renderer.width, view.width, view.size, view.label);
console.log("state", renderer.cache.get("kept"), renderer.events.join(","));
console.log("same", view === renderer);
console.log("missing", view.generation === undefined);
view.generation = 1;
const again = /** @type {unknown} */ (renderer);
console.log("shared", again.generation);
again.generation = 2;
console.log("shared update", view.generation);
view.child.value = 9;
console.log("child", renderer.child.value, view.child === again.child);
for (const key of ["width", "height", "size", "label", "generation"]) console.log("computed", key, view[key]);
for (const key of ["width", "generation"]) view[key] = 100;
console.log("computed update", renderer.width, view.generation);
try { view.label = "changed"; } catch (error) { console.log("readonly", error.name, error.message); }

class Data {
  first = 1;
  second = 2;
}
const data = new Data();
const record = /** @type {unknown} */ (data);
record.extra = 3;
console.log("keys", Object.keys(record).join(","));
console.log("json", JSON.stringify(record));
console.log("descriptor", JSON.stringify(Object.getOwnPropertyDescriptor(record, "extra")));
Object.assign(record, { first: 4, appended: 5 });
console.log("assigned", data.first, record.extra, record.appended, JSON.stringify(record));

// Rejection belongs to the getter's holder, even through a derived instance
// or replacement prototype. Reporting it must not invoke either getter.
let getterReads = 0, constructorReads = 0;
class ReadonlyBase { get locked() { getterReads++; return 1; } }
class ReadonlyChild extends ReadonlyBase {}
const readonly = new ReadonlyChild();
function writeLocked(value) {
  try { value.locked = 2; } catch (error) { console.log("holder", error.message); }
  console.log("reflect", Reflect.set(value, "locked", 3));
}
writeLocked(readonly);
Object.preventExtensions(readonly);
writeLocked(readonly);
const changed = new ReadonlyChild();
const replacement = { get locked() { getterReads++; return 4; } };
Object.setPrototypeOf(changed, replacement);
writeLocked(changed);
Object.defineProperty(replacement, "constructor", { value: function Renamed() {}, configurable: true });
console.log("constructor name", Object.getOwnPropertyDescriptor(replacement, "constructor").value.name);
writeLocked(changed);
Object.defineProperty(replacement, "constructor", { value: function() {}, configurable: true });
console.log("inferred constructor name", Object.getOwnPropertyDescriptor(replacement, "constructor").value.name);
writeLocked(changed);
Object.defineProperty(replacement, "constructor", { get() { constructorReads++; return 1; }, configurable: true });
writeLocked(changed);
Object.setPrototypeOf(replacement, null);
writeLocked(changed);
console.log("getter reads", getterReads, constructorReads);
