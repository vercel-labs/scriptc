class Entry {
  label = "entry";
}
class Cell<T> extends Entry {
  value: T;
  constructor(value: T) {
    super();
    this.value = value;
  }
}
function recover<T>(entry: Entry): Cell<T> | undefined {
  if (entry instanceof Cell) return entry;
  return undefined;
}
function assign<T>(entry: Entry, value: T): boolean {
  if (!(entry instanceof Cell)) return false;
  const cell: Cell<T> = entry;
  cell.value = value;
  return true;
}
const numeric = new Cell<number>(7);
const text = new Cell<string>("first");
const entries: Entry[] = [numeric, text, new Entry()];
const base: Entry = numeric;
const cast = base as unknown as Cell<number>;
console.log(cast === numeric, cast.value);
console.log(recover<number>(entries[0]) === numeric, recover<string>(entries[1]) === text);
console.log(recover<number>(entries[2]) === undefined);
console.log(assign<number>(base, 9), assign<string>(text, "second"));
console.log(numeric.value, text.value);
function erase(entry: Entry): unknown { return entry; }
const erased = erase(numeric);
const restored = erased as Cell<number>;
console.log(restored === numeric, restored.value);
