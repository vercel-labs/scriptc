// A WeakRef is an object: a weak-collection key and a FinalizationRegistry
// unregister token, as three.js's texture tracking uses it.
class Texture { constructor(name) { this.name = name; } }
const tracked = new Set();
const registry = new FinalizationRegistry((ref) => tracked.delete(ref));
function track(object) {
  const ref = new WeakRef(object);
  tracked.add(ref);
  registry.register(object, ref, ref);
  return ref;
}
const a = new Texture("a");
const b = new Texture("b");
const refA = track(a);
const refB = track(b);
console.log(tracked.size, refA.deref().name, refB.deref() === b);
console.log(registry.unregister(refA), registry.unregister(refA));
tracked.delete(refA);
console.log(tracked.size, registry.unregister(refB), tracked.has(refB));
const marks = new WeakMap([[refA, "first"]]);
const seen = new WeakSet([refB]);
console.log(marks.get(refA), marks.has(refB), seen.has(refB), seen.has(refA));
console.log(marks.delete(refA), marks.has(refA));
for (let i = 0; i < 3; i++) {
  const ref = new WeakRef(new Texture("t" + i));
  registry.register(ref.deref(), i, ref);
  console.log(i, registry.unregister(ref), registry.unregister(ref));
}
try {
  registry.register(a, refA, refA);
  registry.register(b, refA, refA);
  console.log("twice", registry.unregister(refA), registry.unregister(refA));
} catch (e) {
  console.log("threw", e.constructor.name);
}
