// A consumer reads members a package's declarations promise but its
// JavaScript adds in ways the inferred literal type misses: absent keys of
// index signatures read undefined, and expando properties read their values,
// as in Node.
import { counts, fonts, settings, stats } from "declared-members";

const key = process.argv.length > 10 ? "size" : "missing";

const s = settings();
console.log(s["font"] ?? "default font", s["size"] ?? "default size", s.family);
console.log(s["font"] === undefined, typeof s["weight"], s.weight ?? "dot miss");
console.log(s[key] ?? "dynamic miss", s[key], Object.keys(s));

const c = counts();
console.log(c["chars"] ?? -1, c["lines"], c[key] === undefined);

const st = stats([4, 9, 2]);
console.log(st.max, st.sum, st.count, st);

const f = fonts();
console.log(f["title"]?.name ?? "no title", f[key] === undefined, f["body"]?.name, f.code.name);
