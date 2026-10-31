// Arrays of class values that mix a base class and its subclasses, with the
// element type the checker infers (the base class): elements construct and
// dispatch to the subclass, and an index past the end throws Node's TypeError.
class Shape {
  area(): number {
    return 0;
  }
}
class Square extends Shape {
  area(): number {
    return 4;
  }
}
class Circle extends Shape {
  area(): number {
    return 3;
  }
}
const shapes = [Square, Circle, Shape];
console.log(shapes.length, new shapes[0]().area(), new shapes[1]().area(), new shapes[2]().area());
let total = 0;
for (const S of shapes) total += new S().area();
console.log(total, shapes[1] === Circle, shapes.map((S) => S.name).join());
try {
  new shapes[3]();
} catch (e) {
  console.log((e as Error).name, (e as Error).message);
}
// A class value checked into a `typeof Shape` slot: a subclass whose
// constructor takes the same arguments constructs, and one whose constructor
// takes an argument the slot does not pass throws a TypeError (Node's from
// reading the missing argument, the compiled program's from the check).
class Sized extends Shape {
  label: string;
  constructor(side: number) {
    super();
    this.label = side.toFixed(1);
  }
}
const values: any[] = [Square, Sized, Shape];
for (const value of values) {
  try {
    const S: typeof Shape = value;
    console.log(new S().area());
  } catch (e) {
    console.log((e as Error).name);
  }
}
