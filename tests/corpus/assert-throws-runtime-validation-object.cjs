// assert.throws and assert.rejects with a validation object known only at
// run time compare each of its keys as Node's expectedException does: the
// key may be the caught error's own or inherited ("name" from
// Error.prototype), a RegExp matches a string value, and a missing key or a
// different value fails with an AssertionError whose message diffs two
// Comparison objects, whose actual and expected are the caught value and
// the validation object, and whose operator names the assert function. A
// validation object without keys throws ERR_INVALID_ARG_VALUE.
"use strict";
const assert = require("assert");

function check(label, thrown, validator) {
  try {
    assert.throws(() => {
      throw thrown;
    }, validator);
    console.log(label, "passed");
  } catch (err) {
    console.log(label, err.name, err.code, err.operator, err.actual === thrown, err.expected === validator, err.message);
  }
}

const plain = new Error("read ECONNRESET");
plain.code = "ECONNRESET";
const typed = new TypeError("bad input value");

check("own and inherited keys", plain, { code: "ECONNRESET", message: "read ECONNRESET", name: "Error" });
check("inherited name only", plain, { name: "Error" });
check("subclass name", typed, { name: "TypeError" });
check("regex message", typed, { name: "TypeError", message: /bad input/ });
check("regex mismatch", typed, { message: /good input/ });
check("own key on an Error", Object.assign(new RangeError("out"), { kind: "coded" }), { kind: "coded", name: "RangeError" });
check("wrong name", typed, { name: "RangeError" });
check("missing key", plain, { errno: -104 });
check("primitive thrown", "text", { message: "text" });
check("empty validator", plain, {});

async function checkRejects(label, thrown, validator) {
  try {
    await assert.rejects(Promise.reject(thrown), validator);
    console.log(label, "passed");
  } catch (err) {
    console.log(label, err.name, err.code, err.operator, err.actual === thrown, err.expected === validator, err.message);
  }
}

checkRejects("rejects inherited name", typed, { name: "TypeError" }).then(() =>
  checkRejects("rejects wrong name", typed, { name: "RangeError" }),
);
