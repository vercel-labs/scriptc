// The JavaScript source's WeakRef: the global as a value, construction
// through it, deref, and the answers inspect and JSON give.
const target = { name: "table" };
const kept = new WeakRef(target);
console.log(kept.deref() === target);
console.log(kept.deref().name);
console.log(kept);
console.log(JSON.stringify(kept));
console.log(Object.prototype.toString.call(kept));
console.log(typeof kept, kept instanceof WeakRef);
console.log(WeakRef.length, WeakRef.name, typeof WeakRef);

// Further arguments are evaluated and ignored.
let evaluated = 0;
console.log(new WeakRef(target, (evaluated = 1)).deref() === target, evaluated);

// The constructor stored in a variable builds the same reference.
const Held = WeakRef;
const built = new Held(target);
console.log(built.deref() === target, built instanceof WeakRef, built instanceof Held);

// Invalid targets, in the order Node checks them.
for (const invalid of [null, undefined, 1, "x", true, 10n]) {
  try {
    new WeakRef(invalid);
  } catch (err) {
    console.log(err.constructor.name, err.message);
  }
}
try {
  new WeakRef();
} catch (err) {
  console.log(err.constructor.name, err.message);
}
console.log(kept.deref() === target);
