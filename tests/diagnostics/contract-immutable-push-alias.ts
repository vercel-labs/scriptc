// A factory's result is fresh only when every value stored into it is fresh.
// Pushing or writing an element read out of a shared mutable array of objects
// into a new array, or into storage that belongs to a new object, leaves the
// source able to change elements published as Immutable, so each publication
// below is refused.
import type { Immutable } from "@scriptc/types";

class Item {
  v: number;
  constructor(v: number) {
    this.v = v;
  }
}

class Box {
  item: Item;
  items: Item[];
  constructor() {
    this.item = new Item(0);
    this.items = [];
  }
}

const SHARED: Item[] = [new Item(1), new Item(2)];

function pushed(): Item[] {
  const out: Item[] = [];
  out.push(SHARED[0]!);
  return out;
}

function indexed(): Item[] {
  const out: Item[] = [];
  out[0] = SHARED[1]!;
  return out;
}

function field(): Box {
  const box = new Box();
  box.item = SHARED[0]!;
  return box;
}

function nested(): Box {
  const box = new Box();
  box.items.push(SHARED[1]!);
  return box;
}

const PUSHED: Immutable<Item[]> = pushed();
const INDEXED: Immutable<Item[]> = indexed();
const FIELD: Immutable<Box> = field();
const NESTED: Immutable<Box> = nested();

SHARED[0]!.v = 99;
console.log(PUSHED[0]!.v, INDEXED[0]!.v, FIELD.item.v, NESTED.items[0]!.v);
