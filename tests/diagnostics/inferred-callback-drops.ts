type Plain = { name: string; n: number };
type Item = Plain & { extra?: boolean };
const plain: Plain[] = [{ name: "a", n: 1 }];
function run<T>(fn: () => T): T {
  return fn();
}
// The checker unifies both returns into Plain[]; the extended objects keep
// `extra` in Node, so converting them into Plain would drop it silently.
const items: Item[] = run(() => {
  if (plain.length === 0) return plain;
  return plain.map((x) => ({ ...x, extra: true }));
});
console.log(items.length);
