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

function readAfter() {
  for (var name in { second: 1 }) {
    // a declared head binding is a string the checker already knows
  }
  return name;
}

console.log("readAfter", readAfter(), typeof readAfter());
