// A rest binding inside a generic function copies every own property the
// pattern did not name, including the properties the type ARGUMENT adds
// beyond the constraint. The checker types the rest as `Omit<T, K>` and
// lists only the constraint's members; the copy is typed by the fields of
// the type the parameter is bound to.
interface Shape {
  hidden?: boolean;
  sides: number;
}

interface Tile extends Shape {
  colour: string;
  edge?: { mm: number; bevel?: boolean };
}

interface Plate {
  radius: number;
  sides: number;
  stamps?: string[];
  hidden?: boolean;
}

// The constraint declares a member that stays in the rest.
function outline<T extends Shape>(shape: T): string {
  const { hidden, ...visible } = shape;
  return `${hidden === true ? "hidden" : "shown"} ${Object.keys(visible).join("+")} ${JSON.stringify(visible)}`;
}

// The pattern names every member the constraint declares, so the rest holds
// only what the type argument adds. It is also the function's result: the
// `Omit` the call site resolves is the record the body packed.
function extras<T extends Shape>(shape: T): Omit<T, "hidden" | "sides"> {
  const { sides, hidden, ...added } = shape;
  return added;
}

// The constraint declares only a member the pattern takes, and the source is
// asserted to an intersection whose extra member the pattern takes as well.
function unscratched<T extends { hidden?: boolean }>(shape: T): string {
  const { scratch, hidden, ...kept } = shape as T & { scratch?: number };
  return `${scratch ?? "no"} scratch, ${hidden ?? "unset"}: ${JSON.stringify(kept)}`;
}

const triangle: Shape = { sides: 3, hidden: false };
const tile: Tile = { sides: 4, colour: "teal", hidden: true, edge: { mm: 2, bevel: true } };
const plain: Tile = { sides: 6, colour: "slate" };
const plate: Plate = { radius: 12.5, sides: 1, stamps: ["kiln", "2019"] };

for (const line of [outline(triangle), outline(tile), outline(plain), outline(plate)]) console.log(line);

const added = extras(tile);
console.log(JSON.stringify(added), added.colour, added.edge?.mm, Object.keys(added).length);
console.log(JSON.stringify(extras(triangle)), JSON.stringify(extras(plate)));

console.log(unscratched(plate));
console.log(unscratched(tile));
console.log(unscratched({ hidden: true }));
console.log(unscratched(plain));

// The rest is a fresh record: a write through it stays out of the source.
added.colour = "ochre";
console.log(tile.colour, added.colour);
