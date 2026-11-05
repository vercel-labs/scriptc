// @requires-libnode
// A package whose top-level code always hits a runtime fence (pump's
// `var` function exported by reference), reached through a natively
// compiled package, runs in a Node island automatically; a `string |
// Buffer` member read from an island object decodes with toString("utf8");
// a CommonJS helper required on both sides is duplicated quietly (its
// exports are declarations).
import { pack } from "tarlike";
import { fromText, fromBytes, onceTotal } from "bloblike";

console.log("pack", pack([1, 2, 3]));
for (const blob of [fromText("plain"), fromBytes("bytes")]) {
  const data = blob.data;
  console.log("blob", blob.mode.toString(8), data.toString("utf8"), typeof data === "string");
}
console.log("once", onceTotal([4, 5]));
