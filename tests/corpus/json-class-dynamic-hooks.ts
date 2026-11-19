// A class instance can receive a `toJSON` after its class was compiled: the
// hook is installed on one instance with `Object.defineProperty`, on the
// prototype, or by replacing the instance's prototype. JSON.stringify reads
// it from the value (or its prototype chain) and serializes the hook's
// result, with the member's key as the hook's argument and a dropped result
// omitted from an object, written null in an array, or the root's undefined.
// A program that writes the name `toJSON` keeps every class instance on the
// runtime walk, so these answers match Node byte for byte.
class Leaf {
  secret = 11;
}
class Proto {
  secret = 3;
}

const leaf = new Leaf();
Object.defineProperty(leaf, "toJSON", {
  value: () => ({ redacted: true }),
  enumerable: false,
});
console.log(JSON.stringify(leaf));
console.log(JSON.stringify({ leaf }));
console.log(JSON.stringify([leaf]));
const tuple: [Leaf, number] = [leaf, 2];
console.log(JSON.stringify(tuple));

// The hook receives the member's key: "" at the root, the field name for a
// member, and the index for an array slot.
const keyed = new Leaf();
Object.defineProperty(keyed, "toJSON", {
  value: (key: unknown) => ({ key }),
});
console.log(JSON.stringify(keyed));
console.log(JSON.stringify({ field: keyed }));
console.log(JSON.stringify([keyed]));
const keyedTuple: [Leaf, number] = [keyed, 5];
console.log(JSON.stringify(keyedTuple));

// A hook that answers undefined drops an object member, is null in an array
// slot, and is the root's undefined value.
const omitting = new Leaf();
Object.defineProperty(omitting, "toJSON", {
  value: () => undefined,
});
console.log(JSON.stringify(omitting));
console.log(JSON.stringify({ omitting }));
console.log(JSON.stringify([omitting]));

// The hook installed on the prototype answers for every instance.
Object.defineProperty(Proto.prototype, "toJSON", {
  value: (key: unknown) => ({ proto: true, key }),
});
console.log(JSON.stringify(new Proto()));
console.log(JSON.stringify({ p: new Proto() }));
