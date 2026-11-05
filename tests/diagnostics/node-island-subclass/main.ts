// A native class extending a class owned by a Node island is SC8011:
// native subclasses of island classes are not supported yet (NI-5b).
import { requireModule } from "@scriptc/node";

interface Lib {
  Point: new (x: number, y: number) => { x: number; y: number; norm(): number };
}
const { Point } = requireModule<Lib>("./lib.cjs");

class Point3 extends Point {
  z = 0;
}
console.log(new Point3(1, 2).norm());
