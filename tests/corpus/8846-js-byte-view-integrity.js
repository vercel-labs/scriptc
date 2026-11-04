"use strict";
// Integrity operations on typed byte views and buffers.
const ta = new Int8Array(0);
console.log("seal", Object.seal(ta) === ta, Object.isSealed(ta), Object.isExtensible(ta), Object.isFrozen(ta));
const full = new Int8Array(2);
try { Object.freeze(full); } catch (e) { console.log(e.constructor.name, e.message); }
Object.preventExtensions(full);
console.log("full", Object.isExtensible(full), Object.isSealed(full));
const dv = new DataView(new ArrayBuffer(4));
console.log("dataview", Object.freeze(dv) === dv, Object.isFrozen(dv));
const u8 = new Uint8Array(0);
console.log("uint8", Object.preventExtensions(u8) === u8, Object.isExtensible(u8), Object.isSealed(u8));
const sealed = new Int8Array(2);
try { Object.seal(sealed); } catch (e) { console.log("seal-full", e.constructor.name, e.message, Object.isExtensible(sealed)); }
