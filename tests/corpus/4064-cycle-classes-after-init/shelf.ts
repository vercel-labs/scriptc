import { Item } from "./item.ts";

export class Shelf {
  static count = 0;
  items: Item[] = [];
  readonly label: string;
  constructor(label: string) {
    this.label = label;
    Shelf.count++;
  }
  add(name: string): Item {
    const item = new Item(name, this);
    this.items.push(item);
    return item;
  }
  describe(): string {
    return `${this.label}: ${this.items.map((i) => i.placed()).join(", ")}`;
  }
}

export const defaultShelf = new Shelf("default");
defaultShelf.add("box");
console.log("shelf ready", Item.created);
