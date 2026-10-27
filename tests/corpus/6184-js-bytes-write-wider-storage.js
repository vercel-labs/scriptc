// Typed-array element writes through storage wider than the checker's
// flow type: a hoisted `var` (ecdsa-sig-formatter's joseToDer) and a
// field that holds undefined until it is assigned (@noble/hashes' HashMD
// buffer). Each write stores into the typed array the receiver holds, or
// throws Node's TypeError for an undefined one after the index and the
// value evaluated.
'use strict';

/** @param {number} n */
function der(n) {
  var dst = Buffer.alloc(n);
  var offset = 0;
  dst[offset++] = 48;
  dst[offset++] = n;
  dst[offset] = 257;
  return dst.toString('hex');
}

/** @param {number} n */
function grow(n) {
  var dst = Buffer.alloc(n);
  for (var i = 0; i < n; i++) dst[i] = i * 3;
  dst = Buffer.concat([dst, Buffer.from([255])]);
  dst[0] = 7;
  return dst.toString('hex');
}

console.log(der(3), grow(4));

/** @param {number} v */
function note(v) {
  console.log('value', v);
  return v;
}

class Hash {
  buffer;
  /** @param {number} n */
  constructor(n) {
    if (n > 0) this.buffer = new Uint8Array(n);
    this.pos = 0;
  }
  digest() {
    const { buffer } = this;
    let { pos } = this;
    buffer[pos++] = note(0x80);
    buffer[pos] = 300;
    return Array.from(buffer).join(',');
  }
}

console.log(new Hash(4).digest());
try {
  console.log(new Hash(0).digest());
} catch (e) {
  console.log(e instanceof TypeError, e.message);
}
