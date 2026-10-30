// Sloppy-mode code ignores writes that strict mode refuses: assignments to
// frozen objects and arrays and to non-extensible objects leave them
// unchanged without an error, while strict functions still throw.
function write(target, key, value) {
  target[key] = value;
  console.log("after", key, JSON.stringify(target));
}
function strictWrite(target, key, value) {
  "use strict";
  try {
    target[key] = value;
    console.log("wrote", key);
  } catch (e) {
    console.log("threw", e.message);
  }
}
const frozen = Object.freeze({ a: 1, b: "x" });
write(frozen, "a", 5);
write(frozen, "z", 5);
strictWrite(frozen, "a", 5);
const closed = Object.preventExtensions(JSON.parse('{"a":1}'));
write(closed, "a", 2);
write(closed, "b", 2);
strictWrite(closed, "b", 2);
const list = Object.freeze([1, 2]);
write(list, "0", 9);
strictWrite(list, "0", 9);
const holder = {};
Object.defineProperty(holder, "fixed", { value: 1, writable: false, enumerable: true });
write(holder, "fixed", 2);
strictWrite(holder, "fixed", 2);
const withSetter = {
  /** @param {number} x */
  set v(x) {
    throw new Error("setter " + x);
  },
};
try {
  write(withSetter, "v", 1);
} catch (e) {
  console.log("setter threw", e.message);
}
console.log(frozen.a, closed.b, list[0], holder.fixed);
