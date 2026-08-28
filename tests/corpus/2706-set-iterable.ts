const tuple = ["a", "b"] as const;
const s1 = new Set(tuple);
console.log("s1:", s1.size, s1.has("a"), s1.has("b"));

const arr: readonly string[] = ["x", "y", "x"];
const s2 = new Set(arr);
console.log("s2:", s2.size, s2.has("x"), s2.has("y"));

const s3 = new Set(s2);
console.log("s3:", s3.size, s3.has("x"));
