// A JavaScript operator applies ToPrimitive/ToNumeric to both operands before
// it runs, so a BigInt operand selects the operator's BigInt form, converts a
// primitive wrapper or a conversion hook to a BigInt, and throws Node's
// TypeError for a mixed, Symbol or unsigned-shift operand. TypeScript sources
// keep their typed refusals; this program pins the JavaScript lane against
// Node byte-for-byte.

// Mixed BigInt and every other primitive kind: ToNumeric converts the other
// operand to a Number and the operation throws.
try { console.log(1n + 1); } catch (e) { console.log(e.name, e.message); }
try { console.log(1 + 1n); } catch (e) { console.log(e.name, e.message); }
try { console.log(4n - 1); } catch (e) { console.log(e.name, e.message); }
try { console.log(2n * "3"); } catch (e) { console.log(e.name, e.message); }
try { console.log(8n / true); } catch (e) { console.log(e.name, e.message); }
try { console.log(8n % null); } catch (e) { console.log(e.name, e.message); }
try { console.log(2n ** undefined); } catch (e) { console.log(e.name, e.message); }

// The bitwise five take the BigInt form of the same mix, and `>>>` has no
// BigInt form at all.
try { console.log(6n & 3); } catch (e) { console.log(e.name, e.message); }
try { console.log(6n | 3n); } catch (e) { console.log(e.name, e.message); }
try { console.log(6n ^ true); } catch (e) { console.log(e.name, e.message); }
try { console.log(6n << 1); } catch (e) { console.log(e.name, e.message); }
try { console.log(6n >> 1.5); } catch (e) { console.log(e.name, e.message); }
try { console.log(6n >>> 1n); } catch (e) { console.log(e.name, e.message); }
try { console.log(6n >>> 1); } catch (e) { console.log(e.name, e.message); }

// A Symbol operand throws whichever conversion reaches it first.
try { console.log(1n / Symbol("s")); } catch (e) { console.log(e.name, e.message); }
try { console.log(Symbol("s") / 1n); } catch (e) { console.log(e.name, e.message); }

// A conversion hook yields its BigInt and the operator computes.
console.log(2n / { valueOf: function () { return 2n; } });
console.log({ valueOf: function () { return 2n; } } * 3n);
console.log(2n * { toString: function () { return 4n; } });
try { console.log({ valueOf: function () { return Symbol("s"); } } % 5n); } catch (e) { console.log(e.name, e.message); }
try { console.log(5n % { toString: function () { return Symbol("s"); } }); } catch (e) { console.log(e.name, e.message); }
console.log(7n ** { valueOf: function () { return 2n; } });

// Symbol.toPrimitive answers ahead of valueOf/toString, including through a
// well-known symbol read into a local, and the hook runs with the operator's
// own hint ("number" for the arithmetic, bitwise and comparison operators,
// "default" for '+').
const primitiveKey = Symbol.toPrimitive;
console.log({ [primitiveKey]: function () { return 9n; } } % 5n);
console.log(5n % { [Symbol.toPrimitive]: function () { return 4n; } });
const hintedObject = { [primitiveKey]: function (hint) { return hint === "number" ? 3n : 7n; } };
console.log(2n ** hintedObject, hintedObject % 5n, 2n < hintedObject, hintedObject + 1n);

// A BigInt target's same-type partner computes. (A partner that is not a
// BigInt keeps tsc's refusal: Node's `x += partner` can leave a string in
// the binding, which BigInt storage cannot hold.)
let added = 1n;
added += 1n;
console.log(added);

// A partner whose ToPrimitive answers a string concatenates even though the
// other operand is a BigInt, so the sum's type is only decided at runtime.
console.log(1n + {}, 1n + [1], 1n + { toString: function () { return "s"; } });
console.log("x" + 1n, 1n + "x", 1n + 2n);

// A BigInt on either side of a comparison; an incomparable string answers
// false because ToNumeric makes it NaN.
console.log(1n < 2, 2n > 1.5, 1n <= true, -3n < false, false < -3n, 2n >= "1");
console.log("1" < 2n, "1n" < 1n, "Infinity" < 1n, 0n < "1e0", 1n > NaN);
console.log({ valueOf: function () { return 3n; } } > 2, 2n < { toString: function () { return "3"; } });

// The conversion hooks run left then right, once each, before the throw.
var order = "";
try {
  console.log({ valueOf: function () { order += "l"; return 1; } } + 1n);
} catch (e) {
  console.log(e.name, e.message, order);
}
order = "";
try {
  console.log(1n + { valueOf: function () { order += "r"; return 1; } });
} catch (e) {
  console.log(e.name, e.message, order);
}

// The same-type operators keep both languages' BigInt semantics.
console.log(5n * 2n, 5n % 2n, 5n - 2n, 5n / 2n, 5n ** 2n, 6n & 3n, 6n | 3n, 6n ^ 3n);
console.log(6n << 1n, 6n >> 1n, -3n % 2n, 1n < 2n, 1n == 1, 1n === 1);
