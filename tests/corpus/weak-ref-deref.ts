// WeakRef keeps its target and deref answers it, as Node answers a target
// the collector has not freed: every target here is still reachable.
const target = { name: "table", rows: [1, 2, 3] };
const ref = new WeakRef(target);
console.log(ref.deref() === target);
console.log(ref.deref()?.name, ref.deref()?.rows.length);
console.log(ref.deref() === ref.deref());
console.log(ref instanceof WeakRef, typeof ref, typeof WeakRef);

// A symbol is a valid target when it is unregistered; one from the global
// registry is permanent, so Node refuses it.
const key = Symbol("key");
console.log(new WeakRef(key).deref() === key);
console.log(new WeakRef(Symbol.iterator).deref() === Symbol.iterator);
try {
  new WeakRef(Symbol.for("table.key"));
} catch (error) {
  console.log((error as Error).message);
}

// A function target.
const handler = (): string => "called";
console.log(new WeakRef(handler).deref() === handler);

// The constructor held as a value builds the same reference; further
// arguments are evaluated and ignored.
let evaluated = 0;
const Held: any = WeakRef;
const built = new Held(target, (evaluated = 1));
console.log(built.deref() === target, built instanceof WeakRef, evaluated);

// A value of the type passes through a parameter and a field.
interface Slot {
  held?: WeakRef<object>;
}
function nameOf(slot: Slot): string {
  return (slot.held?.deref() as { name: string } | undefined)?.name ?? "none";
}
console.log(nameOf({ held: ref }), nameOf({}));

// Node's TypeError for targets that are not objects or symbols.
for (const invalid of [null, undefined, 1, "x", true, 10n]) {
  try {
    new WeakRef(invalid as any);
  } catch (err) {
    console.log(err instanceof TypeError, (err as Error).message);
  }
}
try {
  new (WeakRef as any)();
} catch (err) {
  console.log((err as Error).message);
}
console.log(ref.deref() === target);
