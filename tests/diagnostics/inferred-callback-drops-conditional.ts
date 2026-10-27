type Plain = { name: string; n: number };
type Item = Plain & { extra?: boolean };
const plain: Plain[] = [{ name: "a", n: 1 }];
function run<T>(fn: () => T): T {
  return fn();
}
// The checker unifies both branches into Plain[]; the extended objects keep
// `extra` in Node, so converting them into Plain would drop it silently.
const items: Item[] = run(() =>
  plain.length === 0 ? plain : plain.map((x) => ({ ...x, extra: true })),
);
console.log(items.length);
