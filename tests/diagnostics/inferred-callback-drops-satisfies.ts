type Plain = { name: string; n: number };
type Item = Plain & { extra?: boolean };
const plain: Plain[] = [{ name: "a", n: 1 }];
function run<T>(fn: () => T): T {
  return fn();
}
// `satisfies` checks the return against Plain[] without changing it; the
// extended objects keep `extra` in Node.
const items: Item[] = run(() => {
  if (plain.length === 0) return plain;
  return plain.map((x) => ({ ...x, extra: true })) satisfies Plain[];
});
console.log(items.length);
