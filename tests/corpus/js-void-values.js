"use strict";
// `void 0` where no variable is declared with it and assigned later: a
// constant, a default parameter, a comparison operand, a return value, an
// argument, an element, a member and a conditional arm.
const nothing = void 0;
console.log(nothing, typeof nothing, nothing === undefined);

function label(name, suffix = void 0) {
  if (suffix === void 0) return name;
  return name + suffix;
}
function describe(x) {
  return [x === void 0, void 0 === x, x !== void 0, x == void 0, x != void 0].join(",");
}
console.log(label("a"), label("a", "!"), label("a", undefined));
console.log(describe(undefined));
console.log(describe(null));
console.log(describe(0));
console.log(describe("text"));

function first(list) {
  if (list.length === 0) return void 0;
  return list[0];
}
function show(a, b) {
  return String(a) + "/" + String(b);
}
function choose(flag, value) {
  var picked = flag ? void 0 : value;
  return picked === void 0 ? "none" : picked;
}
console.log(first([]), first(["x"]), first([7]));
console.log(show(void 0, 2), show(1, void 0));
console.log([1, void 0, 3].length, JSON.stringify([1, void 0, 3]));
console.log(JSON.stringify({ a: void 0, b: 1 }));
console.log(choose(true, "v"), choose(false, "v"), choose(false, 5));
console.log(first([]) || void 0, first(["y"]) ?? void 0);

class Holder {
  constructor() {
    this.value = void 0;
    this.count = 0;
  }
  set(v) {
    this.value = v;
    this.count++;
    return this;
  }
}
var h = new Holder();
console.log(h.value, h.count);
h.set("text");
console.log(h.value, h.count);
h.set(12);
console.log(h.value, h.count);
var box = { cache: void 0 };
console.log(box.cache === void 0);
box.cache = "filled";
console.log(box.cache);
