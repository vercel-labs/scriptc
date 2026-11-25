// An erased assertion (`as unknown as Record<string, string>`) cannot change
// the value it is applied to: when the value is statically a Map,
// Object.entries enumerates the value that exists at run time, and a Map has
// no own enumerable properties, exactly as under Node.
const files = new Map<string, string>([
  ["a", "1"],
  ["b", "2"],
]);
const meta = { files };
const copy = new Map(Object.entries(meta.files as unknown as Record<string, string>));
console.log("copy", copy.size, copy.get("a") === undefined);
console.log("keys", Object.keys(meta.files as unknown as Record<string, string>).length);
