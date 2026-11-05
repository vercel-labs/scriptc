// A JavaScript READ of a name nothing declares resolves at run time, exactly
// as Node does: the access throws a catchable ReferenceError whose message
// names the identifier, `typeof` answers "undefined" without throwing, and a
// call through the same name throws at the callee read (plan D-2 / C5). The
// undeclared name is lowered to the runtime's global-read helper, which
// throws Node's "<name> is not defined".
'use strict';

const describe = (label, fn) => {
  try {
    console.log(`${label}: ${String(fn())}`);
  } catch (e) {
    console.log(`${label}: threw ${e.name}: ${e.message}`);
  }
};

console.log("typeof:", typeof neverDeclared);

describe("bare read", () => neverDeclared);
describe("call", () => neverDeclared(1, 2));
describe("member read", () => neverDeclared.length);
describe("arithmetic", () => neverDeclared + 1);
describe("comparison", () => neverDeclared === undefined);
describe("shorthand property", () => {
  const wrapper = { neverDeclared };
  return String(wrapper.neverDeclared);
});
describe("destructuring default", () => {
  const pick = ({ value = unresolvableReference } = {}) => value;
  return pick({});
});
describe("typeof test", () => typeof neverDeclared === "undefined");

// `typeof` never throws, so a guarded read is the one safe shape.
if (typeof maybeConfigured !== "undefined") console.log("configured:", maybeConfigured);
else console.log("configured: unset");

// A declared binding keeps the ordinary lowered path.
let declared = 3;
describe("declared", () => declared * 2);
