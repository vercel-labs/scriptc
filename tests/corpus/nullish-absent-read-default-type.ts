// `items[at] ?? spare` where the checker types the element read present, so
// it types the whole expression as the element alone, while the read is
// absent past the end and the default is then the answer. The result holds
// both sides: the default arrives at its own type in a slot whose type holds
// it (an argument, a result), and the element is the element itself.
class Kayak {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
}
class Ferry {
  name: string;
  decks: number;
  constructor(name: string) {
    this.name = name;
    this.decks = 3;
  }
}
type Craft = Kayak | Ferry;
function show(craft: Craft): string {
  return craft.name + (craft instanceof Ferry ? "/ferry" : "/kayak");
}

const calls: string[] = [];
const moored: Kayak[] = [new Kayak("teal")];
const reserve: Craft = new Ferry("north");
function lateReserve(): Craft {
  calls.push("reserve");
  return reserve;
}

function asArgument(at: number): string {
  return show(moored[at] ?? reserve);
}
function touch(craft: Craft): Craft {
  craft.name = craft.name + "!";
  return craft;
}
function asTouched(at: number): string {
  const craft = touch(moored[at] ?? reserve);
  return show(craft) + " " + (craft === reserve) + "/" + (craft === moored[0]);
}
function asResult(at: number): Craft {
  return moored[at] ?? lateReserve();
}
function chained(at: number, other: number): string {
  return show(moored[at] ?? moored[other] ?? reserve);
}
// `||` over elements that are never falsy by their type is typed the same
// way, and answers the same way.
function viaOr(at: number): string {
  return show(moored[at] || reserve);
}

// A default of null, and of a value type the element type does not hold.
function nameAt(names: string[], at: number): string | null {
  return names[at] ?? null;
}
function describe(name: string | null): string {
  return name === null ? "nobody" : "<" + name + ">";
}
function sizeAt(sizes: number[], at: number, spare: number | string): string {
  const size = sizes[at] ?? spare;
  return typeof size === "number" ? "n" + size : "s" + size;
}
const stock: Record<string, number> = { nails: 40 };
function countOf(part: string, spare: number | boolean): number | boolean {
  return stock[part] ?? spare;
}

console.log(asArgument(0), asArgument(2));
console.log(asTouched(0), asTouched(2));
console.log(show(asResult(0)), show(asResult(2)));
console.log(chained(0, 0), chained(5, 0), chained(5, 6));
console.log(viaOr(0), viaOr(2));
console.log(describe(nameAt(["ada"], 0)), describe(nameAt(["ada"], 4)));
console.log(sizeAt([3], 0, "none"), sizeAt([3], 4, "none"), sizeAt([3], 4, 9));
console.log(countOf("nails", false), countOf("bolts", false), countOf("bolts", 7));
console.log(calls.join(","));
