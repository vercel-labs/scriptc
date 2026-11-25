// assert.throws reads a validation object's keys from the caught value in
// Node's order and stops at the first key that fails: with a custom
// message, the getters of later keys do not run. A getter of the caught
// value that changes the validation object is seen by the comparison of
// the next key, as in Node. Every getter read is logged.
"use strict";
const assert = require("assert");

const reads = [];

function report(label, run) {
  reads.length = 0;
  try {
    run();
    console.log(label, "passed", reads.join(","));
  } catch (err) {
    console.log(label, err.name, err.message.split("\n").join("|"), reads.join(","));
  }
}

function check(label, thrown, validator) {
  report(label, () =>
    assert.throws(() => {
      throw thrown;
    }, validator),
  );
}

function checkWithMessage(label, thrown, validator) {
  report(label, () =>
    assert.throws(
      () => {
        throw thrown;
      },
      validator,
      "custom",
    ),
  );
}

checkWithMessage(
  "custom message stops",
  {
    get a() {
      reads.push("a");
      return 0;
    },
    get b() {
      reads.push("b");
      throw new Error("b read");
    },
  },
  { a: 1, b: 2 },
);
check(
  "generated message reads every key",
  {
    get a() {
      reads.push("a");
      return 0;
    },
    get b() {
      reads.push("b");
      return 2;
    },
  },
  { a: 1, b: 2 },
);
const validator = { a: 1, b: 2 };
check(
  "getter changes the validator",
  {
    get a() {
      reads.push("a");
      validator.b = 3;
      return 1;
    },
    get b() {
      reads.push("b");
      return 3;
    },
  },
  validator,
);
check(
  "regexp key",
  {
    get a() {
      reads.push("a");
      return "abc";
    },
  },
  { a: /b/ },
);
