// Canonical self-concatenating writes must retain JavaScript's aliasing and
// RHS-order semantics while using the runtime's geometric in-place append.
let repeated = "";
for (let i = 0; i < 12000; i++) repeated = repeated + "x";

let compound = "";
const piece = "y";
for (let i = 0; i < 12000; i++) compound += piece;
console.log(repeated.length, repeated.slice(0, 2), repeated.slice(-2));
console.log(compound.length, compound.slice(0, 2), compound.slice(-2));

let aliased = "seed";
const alias = aliased;
aliased = aliased + "!";
console.log(alias, aliased);

let rhsReassign = "left";
rhsReassign = rhsReassign + (rhsReassign = "replacement");
console.log(rhsReassign);

let expressionPosition = "expr";
const yielded = expressionPosition = expressionPosition + "!";
console.log(yielded, expressionPosition);

let doubled = "ab";
doubled = doubled + doubled;
console.log(doubled);

let unicode = "é";
const beforeUnits = unicode.length;
unicode = unicode + "😀";
console.log(beforeUnits, unicode.length, unicode);

// Module-scoped bindings use plain global storage in the native emitters.
let moduleAccumulator = "";
for (let i = 0; i < 2000; i++) moduleAccumulator = moduleAccumulator + "g";
console.log(moduleAccumulator.length, moduleAccumulator.slice(0, 1), moduleAccumulator.slice(-1));

// A captured binding is stored in a ScrBox rather than a local/global slot.
function makeAppender(): () => string {
  let captured = "";
  return () => {
    captured = captured + "z";
    return captured;
  };
}
const append = makeAppender();
console.log(append(), append(), append());
