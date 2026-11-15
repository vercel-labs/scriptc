// An empty array literal with no element type is one array under every
// name, so its element type is decided where it is written. A use that
// would need the array to be two things, or that reaches it through a path
// the compiler does not follow, is refused instead of copied.

// One array used at two element types.
const o = { files: [] };
const names: string[] = o.files;
const sizes: number[] = o.files;
names.push("x");
console.log(o.files.length, sizes.length);

// Through a computed key, which the compiler does not follow.
const p = { items: [] };
const key = "items" as const;
const held: string[] = p[key];
held.push("y");
console.log(p.items.length);

// A shared empty constant read at two element types.
const NONE = [] as const;
const texts: readonly string[] = NONE;
const counts: readonly number[] = NONE;
console.log(texts.length, counts.length);
