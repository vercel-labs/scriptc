// A union that holds itself through an array and a record, in a program
// that also declares a class with fields of that union: the compiler's
// ownership analysis walks every type that could lead to the class, and
// such a union leads back to itself.
type Nest = number | string | null | Nest[] | Shelf;
interface Shelf {
  [slot: string]: Nest;
}

class Tally {
  total = 0;
  // Fields of the union's own type: the analysis asks about each field.
  latest: Nest = null;
  history: Nest[] = [];

  add(value: Nest): number {
    this.latest = value;
    this.history.push(value);
    this.total += weigh(value);
    return this.total;
  }
}

function weigh(value: Nest): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return value.length;
  if (value === null) return 0;
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + weigh(item), 0);
  return Object.keys(value).reduce((sum, slot) => sum + weigh(value[slot] ?? null), 0);
}

const tally = new Tally();
const shelf: Shelf = { top: [1, 2, [3, "four"]], low: { inner: 5, none: null } };
console.log(tally.add(7), tally.add("ab"), tally.add([1, [2, [3]]]), tally.add(shelf));
console.log(tally.history.length, weigh(tally.latest), weigh(tally.history[2] ?? null));
console.log(Object.keys({ extra: 0, ...shelf }).join(","), tally.total);
