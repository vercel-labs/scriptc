// A generic function in a shorthand property (`{ identity }`), with no type
// to pin its type arguments, is the function JavaScript runs for any of
// them, as it is in a full `identity: identity` property.
function identity<T>(value: T): T {
  return value;
}

function pair<A, B>(first: A, second: B): [A, B] {
  return [first, second];
}

const tools = { identity, pair };
console.log(tools.identity(4), tools.identity("text"));
console.log(JSON.stringify(tools.pair(1, "b")));
const explicit = { identity: identity, pair: pair };
console.log(explicit.identity(true), JSON.stringify(explicit.pair([1], null)));
console.log(typeof tools.identity, tools.identity === explicit.identity);
