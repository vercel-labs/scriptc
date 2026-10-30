// for-in over object literals that write the same keys in different
// orders, and over values a function received.
const a = { id: 1, name: "a", ok: true };
const b = { name: "b", ok: false, id: 2 };
const c = { ok: true, id: 3, name: "c" };
function keysOf(value: { id: number; name: string; ok: boolean }): string {
  const keys: string[] = [];
  for (const key in value) keys.push(key);
  return keys.join(",");
}
for (const value of [a, b, c]) {
  const seen: string[] = [];
  for (const key in value) seen.push(key.toUpperCase());
  console.log(seen.join(" "), keysOf(value));
}
