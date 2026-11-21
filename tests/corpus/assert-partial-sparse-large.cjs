// A sparse expectation searched in a large dense actual array: the walk
// advances through the actual elements once, so a missing value costs a
// single pass rather than a rescan per candidate.
const assert = require("node:assert");

const n = 20000;
const actual = Array.from({ length: n }, (_, i) => i);

const missing = [];
missing[5] = -1;
assert.throws(() => assert.partialDeepStrictEqual(actual, missing), {
  name: "AssertionError",
});

const found = [];
found[3] = 0;
found[19999] = n - 1;
assert.doesNotThrow(() => assert.partialDeepStrictEqual(actual, found));

const holey = [];
for (let i = 0; i < 1000; i += 2) holey[i] = i;
const expectedHoles = [];
expectedHoles[499] = 998;
assert.doesNotThrow(() => assert.partialDeepStrictEqual(holey, expectedHoles));

console.log("ok");
