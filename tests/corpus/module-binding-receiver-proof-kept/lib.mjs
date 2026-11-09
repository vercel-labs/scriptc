// Exports whose value names a function in each form the receiver proof
// follows. None reads `this`, so a call through the module binding runs.
import * as inner from "./inner.mjs";

const quiet = process.argv.length > 100;
const make = inner.dual;

export const viaNamespaceFactory = inner.dual(function (n) {
  return "factory " + n;
});
export const viaAliasedFactory = make(function (n) {
  return "aliased " + n;
});
export const namespaceMember = inner.plain;
export const sized = Object.defineProperty(
  function (n) {
    return "sized " + n;
  },
  "length",
  { value: 2 },
);
export const tagged = Object.assign(
  function (n) {
    return "tagged " + n;
  },
  { tag: "t" },
);
export const frozen = Object.freeze(
  inner.dual(function (n) {
    return "frozen " + n;
  }),
);
export const eitherArm = quiet
  ? (n) => "arrow " + n
  : function (n) {
      return "arm " + n;
    };
