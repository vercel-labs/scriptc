// Straight-line runs of constant-key reads on one untyped subject share one
// layout probe (an object guard group): the guard checks the subject's shape
// once and every member of the run reads its slot from the group's entry.
// Every member must still answer exactly what its own property site answers
// when the shape moved between two members, the key is missing, a getter
// answers it, or the receiver is not an ordinary layout-mode object.
//
// The subjects come from JSON.parse, so nothing types them and the reads are
// dynamic-tier property access.

function fresh(text) {
  return JSON.parse(text);
}

// A keyed site, so an answer is read back without joining a group.
function field(o, key) {
  return o[key];
}

// One grouped subject meeting many shapes: the guard keeps a few layouts and
// probes for the rest, and every answer is still the object's own.
const shapes = [
  '{"a":1,"b":2}',
  '{"a":3,"b":4,"c":5}',
  '{"b":6,"a":7}',
  '{"a":8,"b":9,"d":10,"e":11}',
  '{"a":12,"b":13,"f":14,"g":15,"h":16}',
  '{"b":17,"c":18,"a":19}',
];

function sumAB(o, n) {
  let total = 0;
  for (let i = 0; i < n; i++) total += o.a + o.b;
  return total;
}
for (let round = 0; round < 3; round++) {
  for (const text of shapes) {
    const o = fresh(text);
    console.log("loop", round, sumAB(o, 2), field(o, "a"), field(o, "b"));
  }
}

// Two key orders over the same subject: each run carries its own key list.
function sumOrdered(o) {
  return o.b + o.a + o.c;
}
function sumOther(o) {
  return o.c + o.b + o.a;
}
for (const text of shapes) {
  const o = fresh(text);
  console.log("order", sumOrdered(o), sumOther(o));
}

// A call between two members may reshape the subject. The member after it
// checks the shape again and reads through its own site when it moved.
function touch(kind, o) {
  if (kind === "add") o.c = 3;
  else if (kind === "delete") delete o.a;
  else if (kind === "define") Object.defineProperty(o, "a", { get() { return 99; }, configurable: true });
  else if (kind === "freeze") Object.freeze(o);
  else if (kind === "proto") Object.setPrototypeOf(o, { b: 77 });
  else if (kind === "reshape") {
    o.z = 1;
    delete o.z;
  }
  else if (kind === "seal") Object.seal(o);
  return 0;
}
function pair(kind, o) {
  return o.a + touch(kind, o) + o.b;
}
function pairObject() {
  return fresh('{"a":1,"b":2}');
}

const kinds = ["none", "add", "delete", "define", "freeze", "proto", "reshape", "seal"];
for (const kind of kinds) {
  const o = pairObject();
  try {
    console.log("pair", kind, pair(kind, o), field(o, "a"), field(o, "b"), field(o, "c"));
  } catch (e) {
    console.log("pair", kind, "threw", e && e.name);
  }
}

// The same inside a loop: the shape changes on the first iteration and the
// guard meets a new layout on the next.
function loopPair(kind, n) {
  let total = 0;
  const o = pairObject();
  for (let i = 0; i < n; i++) {
    total += o.a + touch(kind, o) + o.b;
    if (kind === "delete" && i === 0) o.a = 5;
  }
  return total;
}
for (const kind of kinds) {
  try {
    console.log("loop-pair", kind, loopPair(kind, 4));
  } catch (e) {
    console.log("loop-pair", kind, "threw", e && e.name);
  }
}

// Only ordinary layout-mode objects take an entry; every other value must
// answer through the site's helper.
function classify(value) {
  return value.a + value.b;
}
function show(label, value) {
  try {
    console.log("kind", label, classify(value));
  } catch (e) {
    console.log("kind", label, "threw", e && e.name);
  }
}
class Point {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }
}
function makeObject() {
  return fresh('{"a":1,"b":2}');
}
show("object", makeObject());
show("dict", (() => {
  const o = makeObject();
  Object.defineProperty(o, "k", { get() { return 1; } });
  return o;
})());
show("frozen", Object.freeze(makeObject()));
show("number", 5);
show("string", "hi");
show("bool", true);
show("null", null);
show("undefined", undefined);
show("array", [7, 8]);
show("function", function named() {});
show("class", new Point(3, 4));
show("map", new Map([["a", 1]]));
show("proto", Object.create({ a: 40, b: 2 }));

// The same subject seen as several kinds across calls.
function alternating(values) {
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    try {
      total += classify(values[i]);
    } catch (e) {
      total += 1;
    }
  }
  return total;
}
console.log(
  "alternating",
  alternating([makeObject(), 5, "hi", null, [7, 8], makeObject(), new Point(1, 2)]),
);

// A key the object lacks but its prototype has as a getter: the probe must
// refuse the layout, and the site's helper must walk to the getter.
const protoWithGetter = {};
Object.defineProperty(protoWithGetter, "k", { get() { return 77; }, configurable: true });
function sumWithProto(o) {
  return o.a + o.k;
}
for (const text of shapes) {
  const o = fresh(text);
  Object.setPrototypeOf(o, protoWithGetter);
  console.log("proto", sumWithProto(o), field(o, "k"));
}

// Every property of a layout-mode object is a data property, so an own
// accessor moves the object to dictionary mode and the guard refuses it.
let accessorCalls = 0;
function sumAccessor(o) {
  return o.a + o.k;
}
const accessor = fresh('{"a":1}');
Object.defineProperty(accessor, "k", {
  get() {
    accessorCalls++;
    return this.a * 10;
  },
  configurable: true,
});
console.log("accessor", sumAccessor(accessor), accessorCalls, field(accessor, "k"), accessorCalls);

// A subject that gains a key between two reads of a run.
function grow(o) {
  o.c = 9;
  return 0;
}
function readAfterGrow(o) {
  return o.a + grow(o) + o.b;
}
const grown = makeObject();
console.log("grow", readAfterGrow(grown), grown.a, grown.b, grown.c);
