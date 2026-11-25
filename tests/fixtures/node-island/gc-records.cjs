"use strict";
let requests = 0;
let length = 0;
const notes = new WeakMap();
const held = [];

exports.handle = (request) => {
  requests++;
  length += request.label.length;
};
// Remembered by identity only: the island keeps no reference.
exports.note = (request, i) => notes.set(request, i);
exports.noted = (kept) =>
  kept.filter((request, i) => notes.get(request) === i).length +
  "/" +
  kept.length +
  " " +
  kept.map((request) => request.attempt).join(",");
exports.hold = (request) => held.push(request);
exports.counts = () => `${requests} ${length} ${held.map((request) => request.label).join(",")}`;
