import type { ProgramLifetime } from "@scriptc/types";
import type { InlineArray } from "@scriptc/experimental";

// Instances whose class keeps an InlineArray field travel through dynamic
// values: interface-typed slots several classes implement, `unknown` values
// that are cast or tested back, and objects printed or serialized. The
// class dispatch reads their members as typed code does, so both runtimes
// print the same.

class Item implements ProgramLifetime {
  readonly kind: number;
  constructor(kind: number) {
    this.kind = kind;
  }
}

class List implements ProgramLifetime {
  readonly pos: number;
  readonly items: InlineArray<Item>;
  constructor(pos: number, items: readonly Item[]) {
    this.pos = pos;
    this.items = items;
  }
  total(): number {
    let sum = 0;
    for (const item of this.items) sum += item.kind;
    return sum;
  }
}

class Tagged extends List {
  readonly tag: string;
  constructor(pos: number, items: readonly Item[], tag: string) {
    super(pos, items);
    this.tag = tag;
  }
}

// An interface with several implementations holds its values as dynamic
// values.
interface Source {
  readonly name: string;
  readonly list: List;
  size(): number;
}

class FileSource implements Source {
  readonly name = "file";
  readonly list: List;
  constructor(list: List) {
    this.list = list;
  }
  size(): number {
    return this.list.items.length;
  }
}

class MemorySource implements Source {
  readonly name = "memory";
  readonly list: List;
  readonly extra: number;
  constructor(list: List, extra: number) {
    this.list = list;
    this.extra = extra;
  }
  size(): number {
    return this.list.items.length + this.extra;
  }
}

function describe(source: Source): string {
  return `${source.name} ${source.size()} ${source.list.pos} ${source.list.total()}`;
}

const lists = [
  new List(1, [new Item(1), new Item(2)]),
  new Tagged(2, [new Item(3)], "t"),
  new List(3, []),
];
const sources: Source[] = [
  new FileSource(lists[0]!),
  new MemorySource(lists[1]!, 10),
  new FileSource(lists[2]!),
];
for (const source of sources) console.log(describe(source));

// Values seen as `unknown`, tested and cast back.
function sizeOf(value: unknown): number {
  if (value instanceof Tagged) return value.total() * 100 + value.pos;
  if (value instanceof List) return (value as List).items.length;
  return -1;
}
const values: unknown[] = [lists[0], lists[1], 7, "x", lists[2]];
for (const value of values) console.log(sizeOf(value));

// A named member read from an untyped view, and a dynamic store of
// another member.
const untyped: any = new MemorySource(lists[0]!, 1);
console.log(untyped.name, untyped.extra, untyped.list.pos);
untyped.note = "seen";
console.log(untyped.note, (untyped as MemorySource).size());

// A checked cast to a record of scalars reads the members its fields name.
function nameOf(value: unknown): string {
  return (value as { readonly name: string }).name;
}
for (const source of sources) console.log(nameOf(source));
function positionOf(value: unknown): string {
  const record = value as { readonly pos: number; readonly tag?: string };
  return `${record.pos} ${record.tag}`;
}
for (const list of lists) console.log(positionOf(list));

// An array method's compiled callback gets the elements of a dynamic array.
const dynamicLists: any = lists;
dynamicLists.forEach((list: any) => console.log(list.pos, list.tag));
console.log(dynamicLists.map((list: List) => list.items.length).join(","));
console.log(
  dynamicLists.some((list: any) => list.pos === 2),
  dynamicLists.filter((list: List) => list.total() > 0).length,
  dynamicLists.find((list: any) => list.pos === 3).pos,
);

// Printing and serializing read the field as an array of the elements.
const box: unknown = { source: sources[1], count: 2 };
console.log(JSON.stringify(box));
console.log(box);
