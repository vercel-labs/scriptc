// A fresh TypeScript object literal handed to an untyped JavaScript
// parameter, or to a parameter type that declares its properties optional,
// is the plain object the callee may reshape: deleting a property works as
// in Node instead of failing on a record layout that requires it.
import { normalize, strip } from "./lib.js";

console.log(JSON.stringify(normalize({ message: "must change at least one field" })));
console.log(JSON.stringify(normalize({ message: "kept", note: 1 })));
const n = 2;
console.log(JSON.stringify(strip({ a: n, b: undefined, c: "x" })));


// A package-declared parameter whose type makes `message` optional, on a
// method the package's JavaScript defines (zod's `.refine(fn, { message })`).
import { schema } from "params-kit";
const s = schema("book");
console.log(s.refine("plain", { message: "must change at least one field" }));
console.log(s.refine("with path", { message: "bad", path: ["a", "b"] }));
