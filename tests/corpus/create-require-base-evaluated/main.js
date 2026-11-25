// The base argument of a run-time createRequire loader is evaluated when the
// declaration runs, exactly as in Node: its side effects happen there, and an
// argument that throws unwinds the enclosing function.
import { createRequire } from "node:module";

let calls = 0;
const makeBase = (suffix) => {
  calls += 1;
  return import.meta.url + suffix;
};

const loader = createRequire(makeBase("#tail"));
console.log("declared:", calls, typeof loader);

function badBase() {
  throw new Error("bad base");
}

function load() {
  const inner = createRequire(badBase());
  return typeof inner;
}

try {
  load();
} catch (error) {
  console.log("unwound:", error.message);
}

// The inline spelling makes its loader from the base before the require
// call runs, so the base's effect happens first there too.
let inlineCalls = 0;
const inlineBase = () => {
  inlineCalls += 1;
  return "/opt/inline";
};
try {
  createRequire(inlineBase())("./missing.cjs");
} catch (error) {
  console.log("inline threw:", error.constructor.name, inlineCalls);
}

// A factory call read as a value makes its loader from the base at the read,
// before anything uses the loader.
let valueCalls = 0;
const valueBase = () => {
  valueCalls += 1;
  return "/opt/value";
};
console.log("factory value:", typeof createRequire(valueBase()), valueCalls);

// The loader's `resolve` answers against the base at run time, so the base
// is made before the query throws.
let resolveCalls = 0;
const resolveBase = () => {
  resolveCalls += 1;
  return "/opt/resolve";
};
try {
  createRequire(resolveBase()).resolve("./missing.cjs");
} catch (error) {
  console.log("resolve threw:", error.constructor.name, resolveCalls);
}

// Reading `resolve` (and `resolve.paths`) off an inline loader is the same:
// the base runs at each read, and the member is a function.
let readCalls = 0;
const readBase = () => {
  readCalls += 1;
  return "/opt/read";
};
console.log(
  "resolve value:",
  typeof createRequire(readBase()).resolve,
  typeof createRequire(readBase()).resolve.paths,
  readCalls,
);
console.log("done:", calls);
