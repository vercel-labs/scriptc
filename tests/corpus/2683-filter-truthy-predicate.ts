// Array.prototype.filter applies ToBoolean to predicate results; predicates
// need not return boolean.

const words = ["", "a", "bb", "ccc"];
console.log(words.filter((s) => s).join(","));
console.log(words.filter((s) => s.length).join(","));

const nums = [-2, -1, 0, 1, 2];
console.log(nums.filter((n) => n).join(","));
console.log(nums.filter((n) => (n === 0 ? "" : "yes")).join(","));

// A `null` result is the unit-ONLY UNION, not a bare unit — it still rides
// the per-arm truthy helper, and every arm is falsy. (A `void`-returning
// predicate is NOT accepted: TS lets a value-returning function fill a
// void slot, so its real answer is unknowable once the ABI discards it.)
let unitCalls = 0;
console.log(nums.filter(() => {
  unitCalls++;
  return null;
}).length, unitCalls);

// -0 and NaN are falsy; a non-empty string and a non-zero number truthy.
const edges = [-0, 0, NaN, 1];
console.log(edges.filter((n) => n).length);
console.log(["", "0"].filter((s) => s).join("|"));

// A mixed-arm union result routes through the interned per-arm helper.
function pick(n: number): string | number {
  return n % 2 === 0 ? "" : n;
}
console.log(nums.filter((n) => pick(n)).join(","));
