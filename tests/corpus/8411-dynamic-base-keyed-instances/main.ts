// Untyped property reads of class instances that typed code passes as their
// base class: subclass instances in a Point[] read their inherited field and
// their own field through an untyped module.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const reader: {
  readX(o: unknown): unknown;
  readTag(o: unknown): unknown;
  sum(list: unknown[]): number;
} = require("./reader.cjs");

class Point {
  x: any;
  constructor(x: any) {
    this.x = x;
  }
}
class Tagged extends Point {
  tag: any;
  constructor(x: any, tag: any) {
    super(x);
    this.tag = tag;
  }
}
function make(i: number): Point {
  return i % 2 === 0 ? new Point(i) : new Tagged(i * 10, "t" + i);
}
const list: Point[] = [];
for (let i = 0; i < 6; i++) list.push(make(i));
console.log(list.map((p) => String(reader.readX(p))).join(" "));
console.log(list.map((p) => String(reader.readTag(p))).join(" "));
console.log(reader.sum(list));
