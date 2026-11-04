import type { ProgramLifetime } from "@scriptc/types";
import type { InlineArray } from "@scriptc/experimental";

// Dynamic code that reads an InlineArray field by name keeps the field an
// ordinary array (warning SC6105): each read through a dynamic view gives
// the field's one array, and writes through it reach the instance, so both
// runtimes print the same.

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

const list = new List(1, [new Item(1), new Item(2)]);
const view: any = list;
console.log(view.items === view.items, view.items.length, view.items[1].kind);
view.items.push(new Item(3));
console.log(list.items.length, list.items[2]!.kind, list.total());

// A computed key may name the field.
const key = ["it", "ems"].join("");
console.log(view[key] === list.items, Object.keys(view).join(","));

// A record built from the instance's members holds the field's array.
function itemsOf(value: unknown): readonly Item[] {
  return (value as { readonly items: readonly Item[] }).items;
}
console.log(itemsOf(list).length, itemsOf(list)[0]!.kind);
