// JavaScript dependency forms from bundled zip packages, which run as Node
// runs them:
// - a var table replaced by an Int32Array view of itself (buffer-crc32);
// - function declarations that redefine themselves on the first call, and
//   Buffer.from over an array with an undefined encoding (yazl);
// - the deprecated `new Buffer(...)` fallback both keep, and the Buffer
//   methods called on the untyped buffers they return.
import { crc32, localHeader, signature, legacy } from 'zip-helpers';

console.log(crc32('hello'), crc32(Buffer.from([1, 2, 3])), crc32('world', 17), crc32(4));
console.log(Array.from(localHeader('a.txt', 9)).join(','));
console.log(Array.from(localHeader('b', 1)).join(','));
console.log(Array.from(signature()).join(','));
console.log(legacy());
