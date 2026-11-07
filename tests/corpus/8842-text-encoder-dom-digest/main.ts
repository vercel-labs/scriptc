/// <reference lib="dom" />
// A dependency's `/// <reference lib="dom" />` puts lib.dom's Web Crypto
// signatures in the program, and lib.dom's `BufferSource` is
// `ArrayBufferView<ArrayBuffer> | ArrayBuffer`: it admits only views over a
// non-shared buffer. Node's TextEncoder.encode allocates a new, non-shared
// ArrayBuffer, so its result is a BufferSource — scriptc's ambient TextEncoder
// must declare the same (as @types/node's `NonSharedUint8Array` does), or this
// call is rejected with SC0001. skipLibCheck keeps the ambient/lib.dom merge
// quiet, as a typical project config does.
const encoder = new TextEncoder();
const data = encoder.encode("scriptc");
const hash = await crypto.subtle.digest("SHA-256", data);
console.log(new Uint8Array(hash).length, encoder.encoding);
