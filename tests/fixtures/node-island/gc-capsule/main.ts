// A native object the program keeps, remembered weakly in a Node island:
// full collections in Node keep its WeakMap entry.
import { check, collect, remember } from "weakkit";

class Point {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
}

const kept = [new Point(1, 2)];
remember(kept[0]!);
collect();
console.log(check(kept[0]!));
