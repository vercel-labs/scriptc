// Object.isFrozen of an object seen through an asserted record type answers
// for the object: false until something freezes it.
type Point = { x: number; y: number };
const p = {} as Point;
console.log("empty", Object.isFrozen(p));
p.x = 1;
console.log("partial", Object.isFrozen(p));
p.y = 2;
console.log("complete", Object.isFrozen(p), p.x + p.y);

// A record seen through a narrower record type after a round trip through unknown.
type Wide = { a: number; b: number; c: number };
type Narrow = { b: number; a: number };
const wide: Wide = { a: 1, b: 2, c: 3 };
const loose: unknown = wide;
const narrow = loose as Narrow;
console.log("view", Object.isFrozen(narrow), Object.isFrozen(wide), narrow.a + narrow.b);
narrow.a = 5;
console.log("view", wide.a, Object.isFrozen(narrow));
