// In a JavaScript file, an array literal mixing strings, other primitives and
// an empty object holds each value as written.
const a = ["12", {}];
console.log(a.length, typeof a[0], typeof a[1]);

const b = ["12", "", true, null, undefined, [7], {}];
console.log(b.length, b.map((x) => (x === null ? "null" : typeof x)).join(","));

const options = [{}, "fallback"];
for (const option of options) console.log(typeof option === "string" ? option : JSON.stringify(option));

let current = {};
current = "replaced";
console.log(current);
