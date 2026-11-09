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

// The operand an operator chooses, a binding nobody assigns again, a
// re-export and the default export.
const none = undefined;
export const afterComma = (0, function (n) {
  return "comma " + n;
});
export const fallback = none ?? function (n) {
  return "fallback " + n;
};
export const either = none || ((n) => "either " + n);
export let neverAssignedAgain = function (n) {
  return "let " + n;
};
export { plain as reexported } from "./inner.mjs";
export default function (n) {
  return "default " + n;
}

// A bound function runs with the receiver it was bound to.
function tagOf(n) {
  return this.tag + " " + n;
}
export const bound = function (n) {
  return this.tag + " " + n;
}.bind({ tag: "bound" });
export const boundByName = tagOf.bind({ tag: "named" });

// A method named `call` on a plain object and on a class's prototype gives
// no function a `call` of its own, so the forwarding exports above keep
// their proof.
const table = {};
table.call = function (n) {
  return "table " + n;
};
class Kind {}
Kind.prototype.call = function (n) {
  return "kind " + n;
};
export const methodsNamedCall = (n) => table.call(n) + ", " + new Kind().call(n);

// A function with a prototype of its own whose members are ordinary.
const withPrototype = function (n) {
  return "prototype " + n;
};
Object.setPrototypeOf(withPrototype, { tag: "p" });
export const throughPrototype = (n) => withPrototype(n) + " " + withPrototype.tag;
