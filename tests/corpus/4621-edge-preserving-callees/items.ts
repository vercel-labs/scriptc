import { compareLists } from "./compare.ts";

export class Item {
  name: string;
  id = 0;
  constructor(name: string) {
    this.name = name;
  }
}

export class Holder {
  list: Item[] = [];
  short: Item[] | undefined = undefined;
  first: Item;
  constructor(first: Item) {
    this.first = first;
  }
}

export function makeHolder(n: number): Holder {
  const h = new Holder(new Item("first"));
  for (let i = 0; i < n; i++) h.list.push(new Item(`item${i}`));
  h.short = [new Item("s0"), new Item("s1")];
  return h;
}

// Read while the cycle is still evaluating: the comparator sees its empty
// list binding before its declaration ran.
let early = "";
try {
  early = String(compareLists(undefined, undefined));
} catch (error) {
  early = error instanceof ReferenceError ? "tdz" : "other";
}
console.log("early", early);

export const emptyItems: readonly Item[] = [];
console.log("late", compareLists(undefined, []));
