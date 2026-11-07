// An array literal hole is an absent element whose every read answers
// undefined: `[].length` counts it, `in` does not see it, and a destructuring
// or parameter pattern over the literal binds undefined for that position.
// A hole in a destructuring target skips the position instead of binding it.
var hole = [1, , 3];
console.log(hole.length, 1 in hole, 2 in hole, hole[1]);

var onlyHoles = [, ,];
console.log(onlyHoles.length, 0 in onlyHoles, 1 in onlyHoles);

// Trailing comma versus hole: `[1, 2,]` is two elements, `[1, 2, ,]` is three.
console.log([1, 2,].length, [1, 2, ,].length, [1, , 2].join("-"));

// Patterns over a literal hole bind undefined, and the skip-a-position form
// leaves its binding alone. (A default over a hole keeps the checker's
// SC1031 refusal for `null | undefined` fields.)
var [a, b, c] = [4, , 6];
console.log(a, b, c);
var [f, , g] = [1, 2, 3];
console.log(f, g);

// The same through a parameter holding a tuple-typed literal.
function triple(x) {
  return [x[0], x[1], x[2], x.length];
}
console.log(triple([9, , 11]).join(","));

// A hole is not an own property, so iteration and spreading see it as
// undefined while Object.keys skips it.
var spread = [...[1, , 3]];
console.log(spread.length, spread[1], Object.keys([1, , 3]).join(","));
for (var value of [5, , 7]) console.log(value);

// JSON turns every hole into null.
console.log(JSON.stringify([1, , 3]), JSON.stringify([,]));
