// A callback whose returns extend the elements it was given keeps the
// added members once its result type names them (an annotation on the
// callback or on the type argument), as Node keeps them on the objects.
type Plain = { name: string; n: number };
type Item = Plain & { extra?: boolean };
const plain: Plain[] = [
  { name: "a", n: 1 },
  { name: "b", n: 2 },
];

function run<T>(fn: () => T): T {
  return fn();
}
async function runAsync<T>(fn: () => Promise<T>): Promise<T> {
  return fn();
}

const annotated = run((): Item[] => {
  if (plain.length === 0) return plain;
  return plain.map((x) => ({ ...x, extra: x.n > 1 }));
});
console.log(JSON.stringify(annotated));

const viaTypeArgument = run<Item[]>(() => {
  if (plain.length > 5) return plain;
  return plain.map((x) => ({ ...x, extra: true }));
});
console.log(JSON.stringify(viaTypeArgument), viaTypeArgument[0]!.extra);

runAsync(async (): Promise<Item[]> => {
  if (plain.length === 0) return plain;
  return plain.map((x) => ({ ...x, extra: false }));
}).then((items) => console.log(items));

// Callbacks whose results the checker types by their own returns keep
// every member already.
const mapped = plain.map((x) => (x.n > 1 ? x : { ...x, extra: true }));
const asItems: Item[] = mapped;
console.log(JSON.stringify(asItems));
const summed = plain.reduce((acc, x) => ({ ...acc, total: acc.total + x.n }), { total: 0, label: "sum" });
console.log(JSON.stringify(summed));
