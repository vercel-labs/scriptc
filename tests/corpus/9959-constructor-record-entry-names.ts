// `name` and `length` read straight off an entry of a record whose values
// are one of several constructors: the entry read in place, by a run-time
// key and by name, beside the same reads through a local. A missing entry
// throws as a property read of undefined does.
type Reader = typeof Number | typeof String | typeof Boolean;
const readers: Record<string, Reader> = { width: Number, title: String, visible: Boolean };

console.log(Object.keys(readers).map((key) => readers[key].name).join(" "));
console.log(Object.keys(readers).map((key) => readers[key].length).join(" "), typeof readers.width);
for (const key of Object.keys(readers)) {
  const reader = readers[key];
  console.log(key, reader.name, reader.length, reader === readers[key]);
}
console.log(readers.width.name, readers["title"].name, readers.visible.length);

const single: Record<string, typeof Number> = { depth: Number };
console.log(single.depth.name, Object.keys(single).map((key) => single[key].length).join(" "));

try {
  console.log(readers["height"].name);
} catch (error) {
  console.log(error instanceof TypeError, (error as Error).message);
}
