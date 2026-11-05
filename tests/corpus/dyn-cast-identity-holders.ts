// Checked casts of dynamic values held by parameters, fields, closures and
// containers keep one identity with the holder's value.

type Point = { x: number; y: number };

// A parameter: the caller's value and the cast result are one object.
function asPoint(value: unknown): Point {
  return value as Point;
}
const shared: unknown = JSON.parse('{"x":1,"y":2}');
const fromParam = asPoint(shared);
fromParam.x = 5;
console.log("parameter", (shared as Point).x, asPoint(shared) === fromParam);

// A field of a class instance.
class Holder {
  data: unknown;
  constructor(data: unknown) {
    this.data = data;
  }
}
const holder = new Holder(JSON.parse('{"x":3,"y":4}'));
const fromField = holder.data as Point;
fromField.y = 40;
console.log("field", JSON.stringify(holder.data), (holder.data as Point) === fromField);

// A value captured by a closure.
const captured: unknown = JSON.parse('{"x":0,"y":0}');
const bump = (): void => {
  (captured as Point).x++;
};
bump();
bump();
console.log("closure", (captured as Point).x);

// Elements of an unknown[] container.
const list: unknown[] = [JSON.parse('{"x":1,"y":1}'), JSON.parse('{"x":2,"y":2}')];
const second = list[1] as Point;
second.x = 20;
console.log("container", JSON.stringify(list), (list[1] as Point) === second);

// A union target with a record arm.
const maybe: unknown = JSON.parse('{"x":7,"y":8}');
const viaUnion = maybe as Point | undefined;
if (viaUnion) viaUnion.x = 70;
console.log("union", (maybe as Point).x);

// A record whose field is an array, mutated through both casts.
type Bag = { items: number[] };
const bagRaw: unknown = JSON.parse('{"items":[1]}');
const bag = bagRaw as Bag;
const items = (bagRaw as { items: unknown }).items as number[];
items.push(2);
bag.items.push(3);
console.log("record array", bag.items.join(","), items.length, bag.items === items);

// A native value boxed as unknown and cast back to its own type.
const nativeList: number[] = [1, 2];
const boxedList: unknown = nativeList;
const backList = boxedList as number[];
backList.push(3);
console.log("native array", nativeList.length, backList === nativeList);
