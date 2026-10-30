// Expected errors stored in an object literal's fields: a JavaScript
// object keeps its fields checked-dynamic, and assert.throws, assert.match
// and the expected-object form convert them to the regex or string the
// fields hold.
"use strict";
const assert = require("assert");

const errMessages = {
  auth: / auth/,
  state: / state/,
  length: /Invalid initialization vector/,
  code: "ERR_CRYPTO_INVALID_IV",
};

const error = (message, code) => {
  const e = new Error(message);
  if (code) e.code = code;
  return e;
};

assert.throws(() => {
  throw error("Unsupported state or unable to authenticate data");
}, errMessages.auth);
assert.throws(() => {
  throw error("Invalid state for operation getAuthTag");
}, errMessages.state);
assert.throws(
  () => {
    throw error("Invalid initialization vector", "ERR_CRYPTO_INVALID_IV");
  },
  { code: errMessages.code, message: errMessages.length },
);
assert.match("unable to auth", errMessages.auth);
assert.doesNotMatch("no match here", errMessages.state);

const report = (label, run) => {
  try {
    run();
    console.log(label, "passed");
  } catch (error) {
    console.log(label, error.name, error.code, error.message.split("\n")[0]);
  }
};
report("wrong message", () =>
  assert.throws(() => {
    throw error("something else");
  }, errMessages.length),
);
report("wrong code", () =>
  assert.throws(
    () => {
      throw error("Invalid initialization vector", "ERR_OTHER");
    },
    { code: errMessages.code },
  ),
);
report("match", () => assert.match("plain text", errMessages.auth));
console.log("done");
