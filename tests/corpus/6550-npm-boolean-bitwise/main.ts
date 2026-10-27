// Bitwise operators over booleans in a JavaScript dependency convert them
// with ToNumber, true to 1 and false to 0, as Node does (async-sema's
// `isFn(pauseFn) ^ isFn(resumeFn)` option check).
import { Sema, bits } from 'token-sema';

const plain = new Sema(3);
const paired = new Sema(2, { pauseFn: () => {}, resumeFn: () => {} });
console.log(plain.capacity, plain.pausable, paired.capacity, paired.pausable);
try {
  new Sema(1, { pauseFn: () => {} });
} catch (error) {
  console.log((error as Error).message);
}
console.log(bits([1, 0, 3]));
console.log(bits([]));
