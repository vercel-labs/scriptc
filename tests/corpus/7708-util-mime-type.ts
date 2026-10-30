// util.MIMEType and util.MIMEParams through their TypeScript types.
import { MIMEType, MIMEParams, format, inspect } from "node:util";

function describe(m: MIMEType): string {
  return `${m.essence} [${m.params.toString()}]`;
}

const types: MIMEType[] = [];
for (const s of ["text/html;charset=utf-8", "application/ld+json", "multipart/form-data; boundary=abc"]) {
  types.push(new MIMEType(s));
}
for (const m of types) console.log(describe(m), m.type.length, m.subtype.toUpperCase());

const parsed: MIMEType | null = MIMEType.parse("bad");
console.log(parsed === null, MIMEType.parse("a/b")?.essence);

const params: MIMEParams = types[0].params;
params.set("level", "1");
let joined = "";
for (const [name, value] of params) joined += `${name}:${value} `;
console.log(joined.trim(), params.has("level"), params.get("missing") ?? "none");
const keys: string[] = [...params.keys()];
const values: string[] = Array.from(params.values());
console.log(keys, values, JSON.stringify(types[0]), JSON.stringify(params));

try {
  new MIMEType("nope");
} catch (e) {
  const err = e as NodeJS.ErrnoException;
  console.log(err instanceof TypeError, err.code, err.message);
}
try {
  types[1].type = "bad type";
} catch (e) {
  console.log((e as Error).message);
}
types[1].subtype = "xml";
console.log(String(types[1]), types[1] instanceof MIMEType, inspect(types[1]), inspect(params));
const empty = new MIMEParams();
console.log(empty.toString() === "", [...empty].length, `${types[2]}`);
const seeded = new Map(params);
const pairs: [string, string][] = [...params.entries()];
console.log(seeded.get("level"), seeded.size, pairs, [...empty.values()]);
console.log(format("%s / %s", types[0], params), `${params}`);
