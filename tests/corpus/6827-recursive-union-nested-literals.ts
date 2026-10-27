// A recursive JSON-like union with an array arm and an index-signature
// record arm: nested literals mix records into arrays and arrays into
// records at every depth.
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function show(value: Json): string {
  return JSON.stringify(value);
}

const config: Json = { list: [1, "two", null, { nested: [true, { deeper: [] }] }], flag: false };
console.log(show(config));
console.log(show({ list: [{ n: true }] }));
console.log(show([1, { k: null }, [{ a: [2] }]]));
console.log(show({ a: { b: [{ c: "x" }, 3] } }));

const rows: Json[] = [{ id: 1, tags: ["a", { t: 2 }] }, [null, { x: [] }]];
console.log(rows.map(show).join(" | "));

let value: Json = [];
value = { replaced: [1, { again: [true] }] };
console.log(show(value));

const doc: { [key: string]: Json } = { items: [{ name: "x", parts: [1, { p: "q" }] }] };
console.log(show(doc));
const items = doc["items"];
if (Array.isArray(items)) {
  items.push({ added: [9] });
  console.log(items.length, show(items));
}
