// Where a list made by Object.values(...).filter/map/flatMap goes next:
// callbacks that are not inline functions, reads in place, every way of
// handing the list on (where it is an ordinary array again), and flatMap
// callbacks of every result kind.
type Dict = Record<string, object>;
const d: Dict = { a: { id: "a", n: 3 }, b: { id: "b", n: 1 }, c: { id: "c", n: 2 } };
const big = (value: object): boolean => (value as { n: number }).n > 1;
const idOf = (value: object): string => (value as { id: string }).id;
function named(value: object, index: number): string {
  return `${index}${(value as { id: string }).id}`;
}

// Callbacks that are not inline functions.
console.log(Object.values(d).filter(big).map(idOf).join(","), Object.values(d).map(named).join(","));
console.log(Object.values(d).map(String).join("|"), Object.values(d).filter(Boolean).length);

// Rest-parameter callbacks receive the arguments the method passes, not the
// parameters they declare.
const restId = (...args: unknown[]): string => `${args.length}${idOf(args[0] as object)}`;
console.log(Object.values(d).map(restId).join(","));
console.log(Object.values(d).filter((...args: unknown[]) => big(args[0] as object)).length);
let restSeen = "";
Object.values(d).forEach((...args: unknown[]) => {
  restSeen += `${args.length}${idOf(args[0] as object)}`;
});
console.log(restSeen, Object.values(d).some((...args: unknown[]) => big(args[0] as object)));

// The list read in place.
console.log(Object.values(d).filter(big).length, Object.values(d).map(idOf).length);
console.log(JSON.stringify(Object.values(d).filter(big)[1]), Object.values(d).filter(big)[9] === undefined);
console.log(JSON.stringify(Object.values(d).filter(big).find((value) => idOf(value) === "c")));
console.log(Object.values(d).filter(big).includes(d["a"]!), Object.values(d).filter(big).indexOf(d["c"]!));
console.log(JSON.stringify(Object.values(d).filter(big).at(-1)), JSON.stringify(Object.values(d).filter(big).slice(1)));
console.log(JSON.stringify(Object.values(d).filter(big).reverse()), JSON.stringify(Object.values(d).filter(big).concat([{ id: "z" }])));
console.log(
  JSON.stringify(Object.values(d).filter(big).sort((x, y) => (x as { n: number }).n - (y as { n: number }).n)),
);

// The list handed on.
const kept: object[] = Object.values(d).filter(big);
const spread = [...Object.values(d).filter(big), ...Object.values(d).map((value) => value)];
const set = new Set(Object.values(d).filter(big));
const copied = Array.from(Object.values(d).filter(big));
const [first, ...rest] = Object.values(d).filter(big);
console.log(kept.length, spread.length, set.size, copied.length, JSON.stringify(first), rest.length);
console.log(JSON.stringify(Object.values(d).filter(big)), String(Object.values(d).map(idOf)));
console.log(Array.isArray(Object.values(d).filter(big)), typeof Object.values(d).filter(big));
let seen = "";
for (const value of Object.values(d).filter(big)) seen += idOf(value);
for (const [index, value] of Object.values(d).filter(big).entries()) seen += `${index}${idOf(value)}`;
console.log(seen, Object.keys(Object.values(d).filter(big)).join(","));
function pass(list: object[]): number {
  list.push({ id: "p" });
  return list.length;
}
function unknownList(list: unknown): string {
  return Array.isArray(list) ? `array of ${list.length}` : typeof list;
}
console.log(pass(Object.values(d).filter(big)), unknownList(Object.values(d).filter(big)));
const picked = Object.values(d).length > 2 ? Object.values(d).filter(big) : [];
console.log(picked.length, (Object.values(d).filter(big) as { id: string }[])[0]!.id);

// flatMap callbacks of every result kind.
console.log(JSON.stringify(Object.values(d).flatMap((value) => [value, idOf(value)])));
console.log(JSON.stringify(Object.values(d).flatMap((value) => (big(value) ? [value] : []))));
console.log(JSON.stringify(Object.values(d).flatMap((value) => Object.keys(value))));
console.log(JSON.stringify(Object.values(d).flatMap((value) => Object.entries(value))));
console.log(JSON.stringify(Object.values(d).flatMap((value) => Object.values(value).filter((field) => typeof field === "number"))));
console.log(JSON.stringify(Object.values(d).flatMap((value): unknown => (big(value) ? Object.values(value) : idOf(value)))));
const nested: Record<string, Dict> = { x: d, y: { q: { id: "q", n: 9 } } };
console.log(
  Object.values(nested)
    .flatMap((group) => Object.values(group))
    .flatMap((value) => Object.values(value))
    .join(","),
);

// Async callbacks.
async function main(): Promise<void> {
  const ids = await Promise.all(Object.values(d).map(async (value) => idOf(value)));
  console.log(ids.join(""));
}
void main();
