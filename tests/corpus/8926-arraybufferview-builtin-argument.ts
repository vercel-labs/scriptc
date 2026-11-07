// A value typed with the ES library's view interface is an argument for the
// builtins that take any view, and the builtin reads the bytes of whatever
// view it is.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

function digest(view: ArrayBufferView): string {
  return createHash("sha256").update(view).digest("hex");
}

function mac(key: string, view: ArrayBufferView): string {
  return createHmac("sha256", key).update(view).digest("hex").slice(0, 16);
}

const backing = new ArrayBuffer(8);
new Uint8Array(backing).set([1, 2, 3, 4, 5, 6, 7, 8]);
const views: ArrayBufferView[] = [
  new Uint8Array(backing, 0, 3),
  new Uint16Array(backing, 2, 2),
  new DataView(backing, 5),
  Buffer.from(backing, 1, 4),
];
for (const view of views) console.log(view.byteLength, digest(view), mac("k", view));

function same(a: ArrayBufferView, b: ArrayBufferView): boolean {
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}
console.log(same(views[0]!, new Uint8Array([1, 2, 3])), same(views[0]!, new Uint8Array([1, 2, 4])));
