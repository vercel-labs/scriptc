import { Shelf } from "./shelf.ts";

export class Item {
  static created = 0;
  readonly name: string;
  readonly shelf: Shelf | null;
  constructor(name: string, shelf: Shelf | null) {
    this.name = name;
    this.shelf = shelf;
    Item.created++;
  }
  placed(): string {
    return this.shelf instanceof Shelf ? `${this.name}@${this.shelf.label}` : `${this.name}@none`;
  }
}
