// crypto.getRandomValues through node:crypto's export and webcrypto:
// integer typed arrays fill in place and come back as the same object;
// views over 65536 bytes throw QuotaExceededError. (The global spelling and
// the float/DataView TypeMismatchError are 6205's.)
import { getRandomValues, webcrypto } from "node:crypto";
import * as nodeCrypto from "node:crypto";

const bytes = new Uint8Array(4096);
const same = webcrypto.getRandomValues(bytes);
function nonzero(view: Uint8Array): boolean {
  for (let i = 0; i < view.length; i++) if (view[i] !== 0) return true;
  return false;
}
function nonzeroWords(view: Uint32Array): boolean {
  for (let i = 0; i < view.length; i++) if (view[i] !== 0) return true;
  return false;
}
console.log(same === bytes, bytes.length, nonzero(bytes));
const words = new Uint32Array(256);
console.log(getRandomValues(words) === words, nonzeroWords(words));
const shorts = new Int16Array(8);
console.log(webcrypto.getRandomValues(shorts) === shorts, nodeCrypto.getRandomValues(new Uint8ClampedArray(3)).length);
console.log(nodeCrypto.webcrypto.getRandomValues(new Int8Array(65536)).length, getRandomValues(new Uint8Array(0)).length);
const buf = Buffer.alloc(16);
console.log(Buffer.isBuffer(getRandomValues(buf)), buf.subarray(4, 8).length);

function attempt(label: string, f: () => unknown): void {
  try {
    f();
    console.log(label, "ok");
  } catch (e) {
    console.log(label, (e as DOMException).name, (e as DOMException).code, (e as Error).message, e instanceof DOMException);
  }
}
attempt("big", () => getRandomValues(new Uint8Array(65537)));
attempt("big32", () => webcrypto.getRandomValues(new Uint32Array(16385)));
