// @deferred-fences: 1
"use strict";
// The same shape through a different fence: an indexed write on a RegExp
// lowers to a runtime fence, and the unreachable statement after it passes a
// declared function to Array#map. The closure-name table lists `square`'s
// wrapper from that statement, so the wrapper must exist even though the
// statement is never emitted; the boxed anonymous callback is what makes the
// emitter build the table at all.
function square(value) {
  return value * value;
}
const boxed = [1, 2].map(function (value, index, list) {
  return value + index + list.length;
});
function unreachable() {
  const pattern = /x/;
  pattern[0] = "x";
  return [1, 2, 3].map(square).join(",");
}
console.log(boxed.join(","), typeof unreachable);
