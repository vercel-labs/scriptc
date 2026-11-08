// Writes through the union reach the object that entered it, and the same object comes back.
type Json = null | boolean | number | string | Json[] | JsonObject;
type JsonObject = { [key: string]: Json };

const fixed = { a: 1 };
const dict: JsonObject = fixed;
dict.z = true;

function setKey(value: Json, key: string, to: Json): void {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) value[key] = to;
}
function dropKey(value: Json, key: string): void {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) delete value[key];
}
const held: Json = dict;
setKey(held, "w", [1, { n: null }]);
console.log(JSON.stringify(fixed), JSON.stringify(dict), JSON.stringify(held));
dropKey(held, "z");
console.log(JSON.stringify(fixed), JSON.stringify(dict), "z" in dict, Object.keys(dict).join(","));
console.log(held === dict, (held as unknown) === fixed);

const nested: Json = { outer: { inner: 1 } };
const outer = (nested as JsonObject).outer;
setKey(outer ?? null, "added", "yes");
console.log(JSON.stringify(nested));

const list: Json[] = [1, "two", [3]];
const asValue: Json = list;
if (Array.isArray(asValue)) asValue.push({ four: 4 });
console.log(list.length, JSON.stringify(list), asValue === list);
const first = list[2];
if (Array.isArray(first)) first.push("pushed");
console.log(JSON.stringify(asValue));

const store = new Map<string, Json>();
store.set("d", dict);
store.set("l", list);
console.log(store.get("d") === dict, store.get("l") === list, JSON.stringify([...store.values()]));
interface Doc { title: string; body: Json; meta?: Json }
const doc: Doc = { title: "t", body: dict };
setKey(doc.body, "viaDoc", 1);
console.log(JSON.stringify(doc), doc.body === dict, doc.meta === undefined, JSON.stringify(fixed));
