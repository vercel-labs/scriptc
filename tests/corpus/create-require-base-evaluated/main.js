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
console.log("done:", calls);
