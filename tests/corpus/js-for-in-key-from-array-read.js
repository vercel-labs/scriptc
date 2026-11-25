// A for-in head whose binding was initialized from an array read writes the
// key string into it all the same. The read can leave the binding undefined
// (an empty or fully popped array), so the collected storage is
// number | undefined; Node stores the key anyway, and the bindings that
// store it, and functions that return it, answer the same value.

/** @param {number[]} list */
function first(list) {
  var key = list[0];
  for (key in { a: 1, b: 2 }) console.log("first", typeof key, key);
  return key;
}

function empty() {
  /** @type {number[]} */
  var list = [];
  var key = list[0];
  for (key in { a: 1 }) console.log("empty", typeof key, key);
  return key;
}

function popped() {
  var list = [7, 8];
  list.pop();
  list.pop();
  var key = list[0];
  for (key in { a: 1, b: 2 }) console.log("popped", typeof key, key);
  return key;
}

function aliased() {
  /** @type {number[]} */
  var list = [];
  var key = list[0];
  for (key in { a: 1 }) console.log("aliased loop", typeof key, key);
  var out = key;
  return out;
}

/** @type {number[]} */
var sharedList = [];
var sharedKey = sharedList[0];
for (sharedKey in { g: 7 }) console.log("shared loop", typeof sharedKey, sharedKey);
function readShared() {
  return sharedKey;
}

console.log("first returned", first([]), first([3]));
console.log("empty returned", empty());
console.log("popped returned", popped());
console.log("aliased returned", aliased());
console.log("shared returned", typeof sharedKey, sharedKey, readShared());
