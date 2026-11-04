// Computed access with Number keys: a typed array and a string answer an
// integral index below their length without forming the key string, and an
// array stores its dense element the same way. Every other key, index and
// receiver keeps the property-key path, so the output pins which keys reach
// an element and which name a property.
function dyn(v) {
  return v;
}

const report = (label, fn) => {
  try {
    console.log(label, fn());
  } catch (error) {
    console.log(label, error.name + ": " + error.message);
  }
};

const bytes = dyn(new Uint8Array([10, 20, 30, 40]));
const nums = dyn(new Float64Array([1.5, 2.5, 3.5]));
const bigs = dyn(new BigInt64Array(3));
const view = dyn(new DataView(new ArrayBuffer(4)));
const text = dyn("abcd");
const list = dyn([1, 2, 3]);

// A key that is not an index answers undefined without naming a property.
for (const key of [0, 1, 3, 4, -0, -1, 1.5, NaN, Infinity]) {
  console.log("u8", String(key), bytes[key], nums[key], text[key], list[key]);
}

// A canonical numeric string is an element key; the spellings that are not
// canonical name properties instead (and a typed array has none).
for (const key of ["0", "3", "4", "-0", "01", "1e3", "4.0", " 1", "-1"]) {
  console.log("named", key, bytes[key], list[key]);
}

// Writes: a valid index stores, -0 is the element 0, and an out-of-range or
// fractional index stores nothing at all.
bytes[1] = 7;
bytes[-0] = 9;
bytes[4] = 5;
bytes[1.5] = 5;
bytes["01"] = 5;
console.log("u8 write", bytes.join(","), bytes["01"], bytes["4"], bytes[1.5]);
nums[-0] = 6.25;
nums[2.5] = 1;
console.log("f64 write", nums.join(","), nums[2.5]);

// The value's ToNumber runs before the index is looked at, so a Symbol or a
// BigInt raises even where the store would be ignored.
report("bytes write bigint", () => {
  bytes[0] = 1n;
  return bytes[0];
});
report("bytes write bigint out of range", () => {
  bytes[9] = 1n;
  return bytes.join(",");
});

// BigInt elements keep their kind, and a number value never converts.
bigs[0] = 1n;
bigs[-0] = 2n;
bigs[3] = 9n;
bigs[1.5] = 9n;
console.log("big", bigs[0], bigs[1], bigs[-0], bigs[3], bigs[1.5], bigs.length);
report("bigint write number", () => {
  bigs[1] = 5;
  return bigs[1];
});

// A DataView has no elements: a numeric key is an ordinary named property.
view[0] = 3;
view[-0] = 4;
console.log("view", view[0], view["0"], view.byteLength);

// A string answers its character; an index beyond the end names nothing.
console.log("str", text[0], text[3], text[4], text[-0], text[1.5]);

// An array answers its dense element, keeps a hole a hole, extends only for
// an index, and names every other key.
const holes = dyn([1, 2, 3]);
delete holes[1];
console.log("hole", holes[1], holes.length, JSON.stringify(holes), 1 in holes);
holes[1] = 4;
holes[3] = 5;
holes[1.5] = 6;
holes["01"] = 7;
holes["1e3"] = 8;
holes[-0] = 9;
console.log(
  "array",
  holes.join(","),
  holes.length,
  holes[1.5],
  holes["01"],
  holes["1e3"],
  JSON.stringify(holes),
);

// An accessor for an integer key, own or inherited, still runs: an element
// store is the only thing the shortcut answers.
const own = dyn({
  get 0() {
    return "own0";
  },
  set 0(value) {
    this.got = value;
  },
});
console.log("accessor read", own[0]);
own[0] = 5;
console.log("accessor write", own[0], own.got);
function Base() {}
Base.prototype = {
  get 0() {
    return "proto" + this.v;
  },
  set 0(value) {
    this.v = value;
  },
  1: "one",
};
const inst = dyn(new Base());
console.log("proto read", inst[0], inst[1]);
inst[0] = 6;
console.log("proto write", inst[0], inst[1], inst.v);

// A frozen or non-extensible array keeps its element stores ignored in
// sloppy mode and refuses them in strict mode.
report("frozen", () => {
  const frozen = dyn([1, 2]);
  Object.freeze(frozen);
  frozen[0] = 9;
  frozen[2] = 9;
  return frozen.join(",") + " " + frozen.length;
});
report("sealed", () => {
  const sealed = dyn([1, 2]);
  Object.preventExtensions(sealed);
  sealed[0] = 9;
  sealed[2] = 9;
  return sealed.join(",") + " " + sealed.length;
});
report("frozen strict", () => {
  "use strict";
  const frozen = dyn([1, 2]);
  Object.freeze(frozen);
  frozen[0] = 9;
  return frozen.join(",");
});
report("sealed strict", () => {
  "use strict";
  const sealed = dyn([1, 2]);
  Object.preventExtensions(sealed);
  sealed[2] = 9;
  return sealed.join(",");
});
