// `typeof` answers the runtime kind string for any value, including a
// property read of an untyped object. A comparison against a literal no
// `typeof` can answer ("unknown") is that string compared, not a refusal,
// and the operand still evaluates exactly once.
function kind(value) {
  return typeof value;
}
console.log("value", kind(1), kind("s"), kind(true), kind(null), kind(undefined), kind({}), kind([]), kind(() => 1), kind(1n), kind(Symbol.for("x")));

function propKind(obj) {
  return typeof obj.thing;
}
console.log("prop", propKind({ thing: 1 }), propKind({}), propKind({ thing: "x" }));

let reads = 0;
const holder = {
  get thing() {
    reads += 1;
    return 1;
  },
};
console.log("getter", "unknown" !== typeof holder.thing, reads);
console.log("missing", "unknown" !== typeof holder.absent, reads);
console.log("known", typeof 1 === "number", typeof 1 === "string", typeof 1 !== "number");

function compare(value, want) {
  return typeof value === want;
}
console.log("computed", compare(1, "number"), compare(1, "string"));
