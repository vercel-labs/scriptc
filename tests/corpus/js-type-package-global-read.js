// A JavaScript read of a name the checker knows only as a type-package
// suggestion: `Bun` gets its own code (TS2868, TS2867 without a `types`
// field) and `describe` the test-runner one (TS2593/TS2582), where a plain
// undeclared name is TS2304. The code differs with the suggestion; the
// runtime semantics do not: Node resolves the name at run time, so a read
// throws `ReferenceError: <name> is not defined`, `typeof` answers
// "undefined", and a feature test through `typeof` is the guarded shape.
'use strict';

const report = (label, fn) => {
  try {
    console.log(`${label}: ${String(fn())}`);
  } catch (e) {
    console.log(`${label}: threw ${e.name}: ${e.message}`);
  }
};

console.log("typeof Bun:", typeof Bun);
console.log("typeof describe:", typeof describe);

report("guarded read", () =>
  typeof Bun === "object" && Bun.escapeHTML ? Bun.escapeHTML("<b>&") : "<b>&",
);
report("bare read", () => Bun.escapeHTML);
report("test runner call", () => describe("suite", () => {}));
report("test runner member read", () => describe.length);
