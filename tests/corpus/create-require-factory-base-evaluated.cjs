// The CommonJS spelling of a run-time createRequire loader: a destructured
// factory makes its loader from the base where the call stands, so the
// base's side effects happen there, exactly as in Node.
"use strict";
const { createRequire: cr } = require("node:module");

let calls = 0;
const makeBase = (suffix) => {
  calls += 1;
  return "/opt/cjs" + suffix;
};

const loader = cr(makeBase("#bound"));
console.log("declared:", calls, typeof loader);

// A factory call read as a value makes its loader from the base at the read.
let valueCalls = 0;
const valueBase = () => {
  valueCalls += 1;
  return "/opt/cjs-value";
};
console.log("factory value:", typeof cr(valueBase()), valueCalls);

// An inline require through the factory evaluates the base before the
// require call runs.
let requireCalls = 0;
const requireBase = () => {
  requireCalls += 1;
  return "/opt/cjs-require";
};
try {
  cr(requireBase())("./missing.cjs");
} catch (error) {
  console.log("require threw:", error.constructor.name, requireCalls);
}

// The loader's `resolve` answers against the base at run time, so the base
// is made before the query throws.
let resolveCalls = 0;
const resolveBase = () => {
  resolveCalls += 1;
  return "/opt/cjs-resolve";
};
try {
  cr(resolveBase()).resolve("./missing.cjs");
} catch (error) {
  console.log("resolve threw:", error.constructor.name, resolveCalls);
}
console.log("done:", calls);
