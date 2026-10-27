import { ThreadSlots } from "@scriptc/experimental";
import { publish } from "@scriptc/threads";

// ThreadSlots value types (class instances, objects, arrays, Maps and
// Sets), families keyed by a base class and by one of its subclasses, and
// published keys. Node.js prints the same.

class Shape {
  readonly sides: number;
  constructor(sides: number) {
    this.sides = sides;
  }
}

class Square extends Shape {
  readonly size: number;
  constructor(size: number) {
    super(4);
    this.size = size;
  }
}

class Point {
  readonly x: number;
  readonly y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
}

interface Note {
  text: string;
  seen: number;
}

const notes = new ThreadSlots<Shape, Note>("values.notes");
const lists = new ThreadSlots<Shape, string[]>("values.lists");
const maps = new ThreadSlots<Square, Map<string, number>>("values.maps");
const sets = new ThreadSlots<Point, Set<number>>("values.sets");
const points = new ThreadSlots<Point, Point>("values.points");

const triangle = new Shape(3);
const square = new Square(2);
notes.set(triangle, { text: "three", seen: 0 });
notes.set(square, { text: "four", seen: 0 });
notes.get(square)!.seen++;
lists.set(square, ["a"]);
lists.get(square)!.push("b");
maps.set(square, new Map([["area", 4]]));
maps.get(square)!.set("perimeter", 8);
console.log(notes.get(triangle), notes.get(square), lists.get(square), lists.has(triangle));
console.log([...maps.get(square)!], maps.has(new Square(2)));

const origin = new Point(0, 0);
sets.set(origin, new Set([1, 2]));
sets.get(origin)!.add(3);
points.set(origin, new Point(1, 1));
points.set(points.get(origin)!, origin);
console.log([...sets.get(origin)!], points.get(points.get(origin)!) === origin);

// Published keys: the slots never write the key.
const frozen = publish(new Square(5));
notes.set(frozen, { text: "published", seen: 1 });
maps.set(frozen, new Map());
console.log(notes.get(frozen)?.text, maps.get(frozen)?.size, frozen.size);
console.log(notes.delete(frozen), notes.has(frozen), maps.has(frozen));

// Replaced values and freed keys.
let total = 0;
for (let round = 0; round < 3; round++) {
  const shapes: Shape[] = [];
  for (let i = 0; i < 2000; i++) {
    const s = i % 2 === 0 ? new Shape(i) : new Square(i);
    shapes.push(s);
    notes.set(s, { text: `first ${i}`, seen: 0 });
    notes.set(s, { text: `second ${i}`, seen: round });
    lists.set(s, [String(i)]);
  }
  for (const s of shapes) total += notes.get(s)!.seen + lists.get(s)!.length;
}
console.log(total, notes.get(triangle)?.text);

// `Note | undefined` as Set elements: reads of that type are tagged boxes.
const seen = new Set<Note | undefined>();
seen.add(notes.get(triangle));
seen.add(notes.get(new Shape(9)));
seen.add(notes.get(triangle));
console.log(seen.size, [...seen].map((n) => n?.text ?? "none").join(","));
