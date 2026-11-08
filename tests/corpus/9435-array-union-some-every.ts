// some, every and findIndex on a value that is one of several array types
// (`Crate[] | string[]`): the method runs on the array the value holds, and
// the callback receives that array's elements.
interface Crate {
  id: number;
  label: string;
}
function contents(kind: number): Crate[] | string[] {
  return kind === 0
    ? [
        { id: 1, label: "bolts" },
        { id: 2, label: "nuts" },
      ]
    : ["loose", "boxed", "sealed"];
}
function counts(kind: number): number[] | string[] | undefined {
  return kind === 0 ? [3, 4] : kind === 1 ? ["p", "q"] : undefined;
}

for (const kind of [0, 1]) {
  const c = contents(kind);
  console.log(
    c.some((x) => typeof x === "string"),
    c.every((x) => typeof x === "object"),
    c.findIndex((x) => (typeof x === "string" ? x === "boxed" : x.id === 2)),
    c.some((x, i) => i === 2),
  );
}
for (const kind of [0, 1, 2]) {
  const c = counts(kind);
  console.log(
    c?.some((x) => x === "q" || x === 4),
    c?.every((x) => typeof x === "number"),
    c?.findIndex((x) => x === "p"),
  );
}

// The first deciding element ends the walk, and holes are not visited.
const order: string[] = [];
function gapped(): number[] | string[] {
  const values: number[] = [];
  values[0] = 5;
  values[3] = 7;
  return values;
}
const holed = gapped();
console.log(
  holed.some((x, i) => {
    order.push(`${i}`);
    return x === 7;
  }),
  order.join(","),
  holed.every((x) => typeof x === "number"),
);
const emptied: number[] | string[] = counts(2) ?? [];
console.log(emptied.some(() => true), emptied.every(() => false), emptied.findIndex(() => true));
