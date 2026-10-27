"use strict";
// One untyped property read site meets class instances (fixed and tracked
// layouts, getters, own properties added later), plain objects, arrays,
// strings, functions, class constructors with statics, null prototypes and
// optional chains. Each receiver kind answers as in Node.

class Status {
  constructor() {
    this.value = "valid";
  }
}

class Lazy {
  constructor(key) {
    this.key = key;
  }
  get value() {
    return `lazy:${this.key}`;
  }
  get length() {
    return 7;
  }
}

class Tracked {
  constructor(list) {
    list.push(this);
    this.value = list.length;
  }
  static value = "static";
}

function plainFunction() {}
plainFunction.value = "fn";

/** @param {any} target */
function readValue(target) {
  return target.value;
}
/** @param {any} target */
function readLength(target) {
  return target.length;
}
/** @param {any} target */
function readOptional(target) {
  return target?.value;
}
/** @param {any} target @param {unknown} value */
function writeValue(target, value) {
  target.value = value;
}

const list = [];
const added = new Status();
writeValue(added, "dirty");
/** @type {any} */
const extra = new Lazy("x");
extra.other = 1;
const nullProto = Object.create(null);
nullProto.value = "bare";
const inherited = Object.create({ value: "from prototype" });
const receivers = [
  new Status(),
  added,
  new Lazy("k"),
  extra,
  new Tracked(list),
  { value: 1, length: 2 },
  { other: true },
  [1, 2, 3],
  "text",
  42,
  true,
  plainFunction,
  Tracked,
  nullProto,
  inherited,
];
for (const receiver of receivers) {
  console.log(typeof receiver, JSON.stringify(readValue(receiver)), JSON.stringify(readLength(receiver)), JSON.stringify(readOptional(receiver)));
}
console.log(readOptional(null), readOptional(undefined));
for (const bad of [null, undefined]) {
  try {
    readValue(bad);
  } catch (e) {
    console.log(e instanceof TypeError, e.message);
  }
}

const plain = { value: 0 };
const arr = [];
writeValue(plain, 5);
writeValue(arr, "on array");
writeValue(inherited, "own now");
writeValue(plainFunction, "fn2");
const status = new Status();
writeValue(status, "aborted");
console.log(plain.value, arr.value, Object.keys(inherited), plainFunction.value, status.value, JSON.stringify(status));
try {
  writeValue("text", 1);
} catch (e) {
  console.log(e instanceof TypeError, e.message);
}
const frozen = Object.freeze({ value: "frozen" });
try {
  writeValue(frozen, 2);
} catch (e) {
  console.log(e instanceof TypeError);
}
console.log(frozen.value);
