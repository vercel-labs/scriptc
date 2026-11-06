// A BigInt binding holds a BigInt. Node's `x op= partner` reads the target,
// applies the operator and stores the result, so a partner that answers a
// string turns the binding into a string ("1[object Object]"), and any
// partner that is not a BigInt reaches the mixed-type TypeError. The
// lowering's BigInt arms take two BigInts, so each compound assignment keeps
// tsc's refusal.
let total = 1n;
total += {};
total -= 1;
console.log(total);
