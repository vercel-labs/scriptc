"use strict";
// Garbage-collection pressure inside Node island calls
// (tests/harness/node-island.test.ts): full collections while the call
// runs on Node's stack, at depth on both sides.
const v8 = require("node:v8");
const vm = require("node:vm");
v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc");

const kept = [];

// Allocates `rounds` batches of objects that survive until the next batch,
// with a full collection after each.
exports.churn = (rounds) => {
  let total = 0;
  for (let r = 0; r < rounds; r++) {
    const batch = [];
    for (let i = 0; i < 100000; i++) batch.push({ i, s: `item ${i}`, tags: [i, i + 1] });
    kept[r % 4] = batch;
    total += batch.length;
    gc();
  }
  return total;
};

// Recurses `depth` frames in JavaScript and collects at the bottom.
exports.deep = (depth) => {
  if (depth === 0) {
    gc();
    return 0;
  }
  const local = { depth, text: String(depth) };
  return 1 + exports.deep(depth - 1) + (local.depth > 0 ? 0 : 1);
};

// Collects after a timer, from Node's loop.
exports.later = async (n) => {
  await new Promise((resolve) => setTimeout(resolve, 1));
  exports.churn(1);
  return n;
};
