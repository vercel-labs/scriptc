// A concise arrow that answers a for-in key answers the string Node stored.
// The checker infers the arrow's result from the binding's declaration, so
// the return slot follows the widened binding instead.

var key = 0;
const getKey = () => key;
const sameKey = () => key;

for (key in { first: 1 }) {
  // the head writes the key string into `key`
}

console.log("getKey", getKey(), typeof getKey());
console.log("same", sameKey(), sameKey() === getKey());

const stored = getKey();
let later = 0;
later = getKey();
console.log("stored", stored, typeof stored);
console.log("later", later, typeof later);

class Keys {
  method() {
    return key;
  }
}

const keys = new Keys();
const fromMethod = keys.method();
const parenthesized = (getKey)();
function forward() {
  return getKey();
}

const forwardArrow = () => getKey();
const forwardParens = () => (getKey());
const parensResult = (getKey());
function forwardLocal() {
  return stored;
}

console.log("forward-arrow", forwardArrow(), typeof forwardArrow());
console.log("forward-parens", forwardParens(), typeof forwardParens());
console.log("parens-result", parensResult, typeof parensResult);
console.log("forward-local", forwardLocal(), typeof forwardLocal());
console.log("method", fromMethod, typeof fromMethod);
console.log("parens", parenthesized, typeof parenthesized);
console.log("forward", forward(), typeof forward());

function readAfter() {
  for (var name in { second: 1 }) {
    // a declared head binding is a string the checker already knows
  }
  return name;
}

console.log("readAfter", readAfter(), typeof readAfter());
