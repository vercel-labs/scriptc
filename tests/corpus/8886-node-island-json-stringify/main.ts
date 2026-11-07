// @requires-libnode
// JSON.stringify reaching a Node island object serializes it as Node does:
// the walk asks V8 for the object's keys and members, runs its toJSON with
// the real key and the replacer with the real holder, and keeps walking the
// native values an island object holds as the native values they are. This
// used to throw "JSON.stringify of a runtime handle is not supported yet",
// for a handle root and for a handle anywhere inside a native value.
import {
  hold,
  makeAny,
  makeBox,
  makeBoxed,
  makeCycle,
  makeDoc,
  makeKeys,
  makeList,
  makeOrdered,
  makeRaw,
  makeRedacted,
  makeRing,
  seen,
  upper,
} from "json-pkg";

// 1. A handle root: an object, an `any`, an array.
const box = makeBox();
console.log(JSON.stringify(box));
console.log(JSON.stringify(makeAny()));
console.log(JSON.stringify(makeList()), JSON.stringify(makeList(), null, 1));
console.log(JSON.stringify(makeOrdered()));

// 2. Gaps, a native replacer, a property list, an island replacer, an
// island property list.
console.log(JSON.stringify(box, null, 2));
console.log(JSON.stringify(box, (_key, value) => (typeof value === "number" ? value + 1 : value)));
console.log(JSON.stringify(box, ["n", "inner", "deep"]));
console.log(JSON.stringify(box, upper), seen());
console.log(JSON.stringify(box, makeKeys()));
// An island replacer or property list applies to a native value too (both
// used to be ignored, silently).
const plain = { a: "x", n: 1, label: "l" };
console.log(JSON.stringify(plain, upper), seen());
console.log(JSON.stringify(plain, makeKeys()));

// 3. Members V8 answers: a Date's toJSON, an omitted undefined and
// function, a getter, boxed primitives, a symbol and a function in an
// array, a raw JSON object.
const doc = makeDoc();
console.log(JSON.stringify(doc));
console.log(JSON.stringify(doc, null, "\t"));
console.log(JSON.stringify(doc.fn), JSON.stringify([doc.fn]));
console.log(JSON.stringify(makeBoxed()), seen());
console.log(JSON.stringify(makeRaw()));

// 4. toJSON receives the key the value is stored under.
console.log(JSON.stringify(makeRedacted()), JSON.stringify({ wrapped: makeRedacted() }));
console.log(JSON.stringify([0, makeRedacted()]), seen());

// 5. A handle inside native values: a record, an array, a dictionary.
const native = { id: 1, box, list: [makeBox(), 2] };
console.log(JSON.stringify(native));
console.log(JSON.stringify(native, null, 2));
const dictionary: Record<string, unknown> = { a: doc, b: "s" };
console.log(JSON.stringify(dictionary));
console.log(JSON.stringify(dictionary, (key, value) => (key === "tags" ? undefined : value)));

// 6. A native value an island object holds is walked as itself.
const record = { x: 1, y: ["p", { q: true }] };
console.log(JSON.stringify(hold(record)), JSON.stringify(hold(record), null, 2));

// 7. Cycles are V8's TypeError, naming the island object's constructor.
function circular(make: () => unknown): void {
  try {
    console.log(JSON.stringify(make()));
  } catch (e) {
    console.log((e as Error).name, (e as Error).message);
  }
}
circular(() => makeCycle());
circular(() => ({ outer: makeCycle() }));
circular(() => makeRing());
circular(() => {
  const mine: { island?: unknown } = {};
  mine.island = hold(mine);
  return mine;
});

// 8. util.format's %j.
console.log("%j", box);
console.log("%j", { native: box });
