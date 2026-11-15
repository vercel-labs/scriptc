// util.isDeepStrictEqual over ArrayBuffer and SharedArrayBuffer: Node's
// areEqualArrayBuffers compares the reported byte length and the bytes, once
// the strict constructor gate passes, so two buffers equal each other by
// content and not by identity, a shared buffer compares with a shared buffer
// only, and the pair still nests in records, arrays and collections.
import { isDeepStrictEqual as equal } from "node:util";

const show = (label: string, value: boolean): void => {
  console.log(`${label}: ${value}`);
};

const first = new ArrayBuffer(4);
const second = new ArrayBuffer(4);
new Uint8Array(first).set([1, 2, 3, 4]);
new Uint8Array(second).set([1, 2, 3, 4]);
show("array buffers", equal(first, second));
show("array buffer identity", equal(first, first));
show("array buffer bytes", (() => {
  new Uint8Array(second)[3] = 9;
  return equal(first, second);
})());
new Uint8Array(second)[3] = 4;
show("array buffer bytes restored", equal(first, second));

show("array buffer lengths", equal(new ArrayBuffer(0), first));
show("empty array buffers", equal(new ArrayBuffer(0), new ArrayBuffer(0)));
show("array buffer vs record", equal(first as any, {}));
show("array buffer vs view", equal(first as any, new Uint8Array([1, 2, 3, 4]) as any));

const shared = new SharedArrayBuffer(3);
const sharedTwin = new SharedArrayBuffer(3);
new Uint8Array(shared).set([7, 8, 9]);
new Uint8Array(sharedTwin).set([7, 8, 9]);
show("shared buffers", equal(shared, sharedTwin));
show("shared bytes", (() => {
  new Uint8Array(sharedTwin)[0] = 1;
  return equal(shared, sharedTwin);
})());
show("shared lengths", equal(new SharedArrayBuffer(2), new SharedArrayBuffer(3)));
show("shared vs array buffer", equal(shared as any, new ArrayBuffer(3) as any));
show("array buffer vs shared", equal(new ArrayBuffer(3) as any, shared as any));

show("buffers nested", equal({ b: first }, { b: second }));
show("buffers in arrays", equal([first], [second]));
show("buffers in maps", equal(new Map([["k", first]]), new Map([["k", second]])));
show("buffers in sets", equal(new Set([first]), new Set([second])));
show("shared as map key", equal(
  new Map([[new SharedArrayBuffer(2), 1]]),
  new Map([[new SharedArrayBuffer(2), 1]]),
));
show("buffer vs something", equal({ b: first }, { b: new Uint8Array([1, 2, 3, 4]) }));

// A DataView has no typed-array tag, so it never matches a numeric typed
// array of the same width, while two DataViews compare by their bytes.
const bytes = new Uint8Array([1, 2, 3, 4]);
show("data views", equal(new DataView(new ArrayBuffer(2)), new DataView(new ArrayBuffer(2))));
show("data view vs typed array", equal(new DataView(bytes.buffer) as any, bytes as any));
show("typed array vs data view", equal(bytes as any, new DataView(bytes.buffer) as any));
show("data view offsets", equal(
  new DataView(new ArrayBuffer(4), 0, 2),
  new DataView(new ArrayBuffer(4), 2, 2),
));
show("clamped vs plain", equal(new Uint8ClampedArray([1, 2]) as any, new Uint8Array([1, 2]) as any));

console.log("done");
