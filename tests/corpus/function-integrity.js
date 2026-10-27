// Object.freeze, seal and preventExtensions on functions, and the queries:
// they act on the function's own properties (name, length, prototype, and
// the ones a program assigns), as in Node. A frozen function still calls,
// and its properties still read.
const createHasher = (block) => {
  const hash = (msg) => msg.length * block;
  hash.outputLen = 32;
  hash.blockLen = block;
  hash.create = () => hash(" ".repeat(block));
  return Object.freeze(hash);
};
const sha = createHasher(64);
console.log(sha("abc"), sha.outputLen, sha.blockLen, sha.create(), sha.name, sha.length);
console.log(Object.isFrozen(sha), Object.isSealed(sha), Object.isExtensible(sha));
try {
  sha.extra = 1;
} catch (error) {
  console.log(error.name, error.message);
}
try {
  sha.outputLen = 64;
} catch (error) {
  console.log(error.name);
}
console.log(sha.outputLen, sha.extra);

function plain(a, b) {
  return a + b;
}
console.log(Object.isFrozen(plain), Object.isSealed(plain), Object.isExtensible(plain));
plain.tag = "t";
Object.seal(plain);
console.log(Object.isFrozen(plain), Object.isSealed(plain), Object.isExtensible(plain));
plain.tag = "u";
console.log(plain.tag, plain(1, 2), plain.name, plain.length);

const stopped = () => 0;
Object.preventExtensions(stopped);
console.log(Object.isFrozen(stopped), Object.isSealed(stopped), Object.isExtensible(stopped));
try {
  stopped.late = 1;
} catch (error) {
  console.log(error.name, error.message);
}
console.log(stopped.name, stopped.length);
