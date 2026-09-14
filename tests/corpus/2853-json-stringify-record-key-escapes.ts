// JSON.stringify escapes record property NAMES exactly like Node: backslash,
// double quote, the short escapes, and C0 control bytes all survive a
// round-trip, in both the all-required and the droppable/overflow record
// writers and in both the C and LLVM backends.
const simple = { "a\\nb": 1, plain: 2 };
console.log(JSON.stringify(simple));

const quote = { 'q"q': 1 };
console.log(JSON.stringify(quote));

const control = { "a\u0001b": 1, "c\td": 2 };
console.log(JSON.stringify(control));

const optional: { "a\\nb"?: number; z: number } = { "a\\nb": 1, z: 2 };
console.log(JSON.stringify(optional));

const indexed: Record<string, number> = { "a\\nb": 1 };
console.log(JSON.stringify(indexed));

console.log(JSON.stringify({ outer: { "a\\nb": 1 } }));
console.log(JSON.stringify([{ "a\\nb": 1 }]));
console.log(JSON.stringify(simple, null, 2));

// The escaped form must parse back to the same key, not to a control byte.
const reparsed = JSON.parse(JSON.stringify(simple)) as Record<string, number>;
console.log(reparsed["a\\nb"], reparsed["plain"]);
