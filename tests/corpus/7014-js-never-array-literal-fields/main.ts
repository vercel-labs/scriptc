// A JavaScript package whose object literals start an array property as
// `[]` inside a literal that maps to a record, as zod 3's parse context does
// (`{ common: { issues: [] }, path: params?.path || [] }`), and later push
// records onto it. Node runs the pushes; each array holds them.
import { Schema, rows } from "mini";

const s = new Schema();
console.log(JSON.stringify(s.safeParse(1)), JSON.stringify(s.safeParse("a")));
console.log(JSON.stringify(s.safeParse(2, { path: ["root"] })));
console.log(rows());
