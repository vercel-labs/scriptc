// Strict equality between untyped values: the same object, equal and
// unequal primitives, NaN, null and undefined, functions and arrays.
function eq(a, b) { return a === b; }
var o = { x: 1 }, f = function () {}, arr = [1];
var nan = 0 / 0;
console.log(eq(o, o), eq(o, { x: 1 }), eq(nan, nan), eq(1, 1), eq("a", "a"), eq("a" + 1, "a1"), eq(1, "1"));
console.log(eq(null, undefined), eq(null, null), eq(undefined, undefined), eq(f, f), eq(arr, arr), eq(arr, [1]), eq(true, true), eq(true, 1));
var list = [o, f, nan, "s", 2]; var hits = 0;
for (var i = 0; i < list.length; i++) for (var j = 0; j < list.length; j++) if (eq(list[i], list[j])) hits++;
console.log(hits);
