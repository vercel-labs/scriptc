"use strict";
// The harness object of Node's test/common/wpt.js, without its WPT runner.
const assert = require("assert");

const harness = {
  test: (fn, desc) => {
    try {
      fn();
    } catch (err) {
      console.error(`In ${desc}:`);
      throw err;
    }
  },
  assert_equals: assert.strictEqual,
  assert_true: (value, message) => assert.strictEqual(value, true, message),
  assert_false: (value, message) => assert.strictEqual(value, false, message),
  assert_throws: (code, func, desc) => {
    assert.throws(
      func,
      function (err) {
        return typeof err === "object" && "name" in err && err.name.startsWith(code.name);
      },
      desc,
    );
  },
  assert_array_equals: assert.deepStrictEqual,
  assert_unreached(desc) {
    assert.fail(`Reached unreachable code: ${desc}`);
  },
};

module.exports = { harness };
