// @requires-libnode
// Typed arrays, Buffers, Maps and Sets passed into a Node island are live
// there (scope-B NI-5b): byte views share memory, and island Map and Set
// operations reach the native collection.
import { show, bytesInfo, fill, hexOf, isKept, keep, mapInfo, mapUpdate, setInfo, setUpdate } from "coll-pkg";

const bytes = new Uint8Array([1, 2, 3, 4]);
console.log(bytesInfo(bytes));
fill(bytes, 9);
console.log("filled", bytes.join(","));
console.log("hex", hexOf(Buffer.from("hi!")));

const m = new Map<string, number>([
  ["a", 1],
  ["b", 2],
]);
console.log(mapInfo(m));
mapUpdate(m);
console.log("native map", [...m.entries()].map(([k, v]) => `${k}=${v}`).join(" "), m.size);
m.set("d", 4);
console.log(mapInfo(m));

const s = new Set<number>([1, 2, 3]);
console.log(setInfo(s));
setUpdate(s);
console.log("native set", [...s].join(","), s.size);
keep(m);
console.log("identity", isKept(m), isKept(s));
console.log("inspect", show(m), show(s), show(bytes));
