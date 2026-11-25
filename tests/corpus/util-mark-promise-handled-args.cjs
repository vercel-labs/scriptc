// util.markPromiseAsHandled validates its argument: every non-promise
// throws ERR_INVALID_ARG_TYPE with Node's argument-validation description
// ("type number (5)", "an instance of Object", "function <name>"), and a
// promise is accepted and answered with undefined. The call has no other
// effect on a promise: the value is still awaitable.
"use strict";
const util = require("node:util");

const values = [undefined, null, 5, true, {}, [1], () => {}, { then() {} }];
for (const value of values) {
  try {
    const result = util.markPromiseAsHandled(value);
    console.log("ok", typeof value, result);
  } catch (e) {
    console.log(e.name, e.code, e.message);
  }
}

const accepted = util.markPromiseAsHandled(Promise.resolve(1));
console.log("accepted", accepted);

async function main() {
  const p = Promise.resolve(7);
  util.markPromiseAsHandled(p);
  console.log("value", await p);
}

main();
