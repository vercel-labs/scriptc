// A run of constant-key reads shares one layout probe, and the probe answers
// only while the shape it names holds. A call between members may reshape the
// subject, so every member after it checks the shape again: the first one may
// have answered through its own site, which leaves the shared entry behind
// the object the later members read. A binding that another operand assigns
// names a different object after the operand runs, so it can share no guard.
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

// Four numbers in, one out: the reads that are its arguments stay members of
// one run, and one of them is a call that may reshape the subject.
function mix(a, b, c, d) {
  return (a - b) * 10 + (c - d) * 100;
}

// Deleting a key moves the object out of layout mode: the entry the group
// holds no longer describes the object at all.
function drop(o, key) {
  delete o[key];
  return o.b;
}
function afterDrop(o) {
  return mix(o.a, drop(o, "a"), o.b, o.b);
}
for (let round = 0; round < 3; round++) {
  const o = fresh('{"a":5,"b":2,"c":3}');
  console.log("drop", afterDrop(o), field(o, "b"), field(o, "c"), field(o, "a"));
}

// The same for a call that defines an accessor, freezes or seals the subject:
// each one takes the object out of layout mode.
function defineGetter(o) {
  Object.defineProperty(o, "k", { get() { return 7; }, configurable: true });
  return o.b;
}
function afterDefine(o) {
  return mix(o.a, defineGetter(o), o.b, o.b);
}
function freezeIt(o) {
  Object.freeze(o);
  return o.b;
}
function afterFreeze(o) {
  return mix(o.a, freezeIt(o), o.b, o.b);
}
function sealIt(o) {
  Object.seal(o);
  return o.b;
}
function afterSeal(o) {
  return mix(o.a, sealIt(o), o.b, o.b);
}
for (const [label, run] of [
  ["define", afterDefine],
  ["freeze", afterFreeze],
  ["seal", afterSeal],
]) {
  const o = fresh('{"a":5,"b":2,"c":3}');
  console.log(label, run(o), field(o, "b"), field(o, "c"));
}

// A call that adds a key keeps layout mode and the slot of every key the
// entry named, so the members after it answer through the entry.
function grow(o) {
  o.d = 4;
  return o.b;
}
function afterGrow(o) {
  return mix(o.a, grow(o), o.b, o.b);
}
for (let round = 0; round < 2; round++) {
  const o = fresh('{"a":5,"b":2,"c":3}');
  console.log("grow", afterGrow(o), field(o, "b"), field(o, "c"), field(o, "d"));
}

// A store after the reshape takes the same path as a read.
function afterDropStore(o) {
  return mix(o.a, drop(o, "a"), o.b, (o.b = 9));
}
for (let round = 0; round < 2; round++) {
  const o = fresh('{"a":5,"b":2,"c":3}');
  console.log("drop-store", afterDropStore(o), field(o, "b"), field(o, "c"));
}

// A binding another operand assigns names a different object afterward. The
// scan that decides which bindings may share a guard looks inside operands
// too, so the reads below answer through their own sites.
function id(value) {
  return value;
}
function afterReplace(o) {
  const before = o.a - o.b;
  id((o = "text"));
  return before + (o.a - o.b);
}
function afterSwap(o, other) {
  const before = o.a - o.b;
  id((o = other));
  return before + (o.a - o.b);
}
for (let round = 0; round < 2; round++) {
  console.log("replace", afterReplace(fresh('{"a":5,"b":2,"c":3}')));
  console.log("swap", afterSwap(fresh('{"a":5,"b":2,"c":3}'), fresh('{"b":8,"c":7,"a":6}')));
}
