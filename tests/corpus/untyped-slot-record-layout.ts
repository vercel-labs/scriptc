// A data literal that flows into an untyped slot while the checker names one
// closed record type as its target is built in that type's layout. A read back
// at that type then takes the object itself: identity holds, writes on either
// side are seen on the other, absent optional members stay absent, and the
// keys keep the order the literal wrote them in.
interface Reading {
  station: string;
  celsius: number;
  wind?: number;
  note?: string;
}

class Shelf {
  held: unknown;
  constructor(held: unknown) {
    this.held = held;
  }
}

function describe(r: Reading): string {
  const text = r.station + ":" + r.celsius + ":" + r.wind + ":" + r.note;
  r.celsius += 1;
  return text;
}

function keysOf(value: unknown): string {
  return Object.keys(value as object).join(",") + " " + JSON.stringify(value);
}

// satisfies, in a local, a class member, an array element and a Map value
function locals(): void {
  const held: unknown = { station: "north", celsius: 4 } satisfies Reading;
  const first = held as Reading;
  const second = held as Reading;
  console.log("local", first === second, first.station, first.celsius, first.wind, first.note);
  first.wind = 9;
  console.log("local typed write", (held as any).wind, keysOf(held));
  (held as any).note = "gusty";
  console.log("local untyped write", first.note, "note" in first, keysOf(held));
}
locals();

const shelf = new Shelf({ celsius: 11, station: "east", note: "calm" } satisfies Reading);
const onShelf = shelf.held as Reading;
console.log("member", onShelf === (shelf.held as Reading), keysOf(shelf.held));
onShelf.celsius = 12;
delete (shelf.held as any).note;
console.log("member after", onShelf.celsius, onShelf.note, "note" in onShelf, keysOf(shelf.held));

const row: unknown[] = [{ station: "west", celsius: -2, wind: 3 } satisfies Reading];
const table = new Map<string, unknown>();
table.set("south", { station: "south", celsius: 20 } satisfies Reading);
const reader: (value: any) => string = describe;
console.log("element", reader(row[0]), reader(row[0]), keysOf(row[0]));
console.log("map", reader(table.get("south")), reader(table.get("south")), keysOf(table.get("south")));

// a parameter whose declared type is computed from the reader's own parameter
class Held {
  reader: (value: any) => string;
  value: unknown;
  constructor(reader: (value: any) => string, value: unknown) {
    this.reader = reader;
    this.value = value;
  }
}
function hold<R extends (value: any) => string>(reader: R, value: Parameters<R>[0]): Held {
  return new Held(reader, value);
}
const kept = hold(describe, { station: "ridge", celsius: 7 });
console.log("computed", kept.reader(kept.value), kept.reader(kept.value), keysOf(kept.value));

// a dynamic call of the reader
const slot: { fn: unknown } = { fn: describe };
const spare: unknown = { station: "bay", celsius: 1, note: "fog" } satisfies Reading;
console.log("call", (slot.fn as any)(spare), (slot.fn as any)(spare), keysOf(spare));

// nested records and arrays keep one identity too
interface Tag {
  name: string;
  weight?: number;
}
interface Crate {
  id: number;
  tag: Tag;
  tags: Tag[];
  label?: string;
}
const crate: unknown = { id: 1, tag: { name: "t" }, tags: [{ name: "u", weight: 2 }, { name: "v" }] } satisfies Crate;
const c = crate as Crate;
c.tag.weight = 5;
c.tags.push({ name: "w" });
console.log("nested", (crate as Crate) === c, (crate as Crate).tag === c.tag, JSON.stringify(crate));

// one site reached several times makes one object per visit
const many: unknown[] = [];
for (let i = 0; i < 3; i++) many.push({ station: "s" + i, celsius: i } satisfies Reading);
const typed = many.map((value) => value as Reading);
console.log("loop", typed[0] === typed[1], typed[2] === (many[2] as Reading), typed.map((r) => r.station + r.celsius).join(","));

// a bare literal in an untyped slot is a plain object; the first read at the
// type adopts it, and later reads take the same record
const wide: unknown = { station: "peak", celsius: 3, wind: 1, note: "n" };
console.log("plain object", describe(wide as Reading), describe(wide as Reading), keysOf(wide));
console.log("plain object identity", (wide as Reading) === (wide as Reading));
