// Array-derived missing string keys use JavaScript ToPropertyKey: undefined -> "undefined".
const keys: string[] = ["a"];
keys.length = 2;
const source: Record<string, string> = { a: "A", undefined: "U" };
const target: Record<string, string> = {};
for (const key of keys) {
  console.log("read", typeof key, source[key]);
  target[key] = typeof key;
}
console.log("write", target.a, target.undefined);

const rows: { value: number }[] = [{ value: 1 }];
for (const row of rows) console.log("keys", Object.keys(row).join(","));
