// The `length` of a method with a default parameter, on a class that
// extends an island class: Node stops counting at the default (0 here),
// the read would answer the parameter count. Refused by name; the class's
// own `length` is answered as Node answers it (main.ts).
import { Tray } from "seed-kit";

class Shelf extends Tray {
  constructor(rows: number, cols?: number) {
    super(rows, cols ?? rows);
  }
  volume(depth = 1, unit?: string): string {
    return String(this.rows * this.cols * depth) + (unit ?? "");
  }
}

console.log(new Shelf(2).volume.length);
