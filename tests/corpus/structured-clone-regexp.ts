// structuredClone over the serializable native values: a RegExp clones as a
// new RegExp over the same source and flags with lastIndex reset (the
// serialization drops it), a Date keeps its time value, a Map and a Set
// clone their entries deeply, and a typed array keeps its element type.
const pattern = /ab+c/gi;
pattern.lastIndex = 5;
const cloned = structuredClone(pattern);
console.log(cloned.source, cloned.flags, cloned.lastIndex, cloned instanceof RegExp);
console.log(pattern.lastIndex, cloned === pattern);

const nested = structuredClone({ re: /x/, when: new Date(1700000000000) });
console.log(nested.re.source, nested.re.flags, nested.when.toISOString());

const map = structuredClone(new Map<string, number[]>([["k", [1, 2]]]));
console.log(map instanceof Map, map.get("k")?.join(","));
const set = structuredClone(new Set([1, 2, 2]));
console.log(set instanceof Set, [...set].join(","));

const bytes = structuredClone(new Uint8Array([1, 2, 3]));
console.log(bytes instanceof Uint8Array, bytes.join(","));

// The flags and their own-value reads survive the copy.
const sticky = structuredClone(/y/y);
console.log(sticky.sticky, sticky.global, sticky.flags);
