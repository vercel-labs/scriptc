/// <reference path="./shims.d.ts" />
/// <reference path="./globals.d.ts" />
// A type has no implementation, whatever kind of declaration file spells it:
// an `@types` package whose runtime package is not installed, an installed
// package whose entry is its declaration file, an ambient `declare module`,
// and a global declaration file. The values are records the program builds.
import type { Box, Boxes } from "ambient-shapes";
import type { Path, Point } from "plain-shapes";
import type { Size, Sized } from "shape-entry";

class Canvas {
  origin: Point | undefined;
  path: Path = [];
  settings: Settings = { name: "default" };
  boxes = new Map<string, Box>();
  add(point: Point): number {
    if (this.origin === undefined) this.origin = point;
    return this.path.push(point);
  }
}

function area(size: Size): number {
  return size.width * size.height;
}
function sized<T>(value: T, size: Size): Sized<T> {
  return { value, size };
}
function describe(box: Box | Point | undefined): string {
  if (box === undefined) return "nothing";
  return "size" in box ? `box ${box.id} ${box.size}` : `point ${box.x},${box.y}`;
}

const canvas = new Canvas();
console.log(canvas.origin === undefined, canvas.add({ x: 1, y: 2 }), canvas.add({ x: 3, y: 4, label: "end" }));
console.log(canvas.origin?.x, canvas.path.map((p) => p.label ?? "-").join(","), canvas.settings.name);

const box: Box = { id: "b1", size: 3 };
canvas.boxes.set(box.id, box);
canvas.boxes.set("b2", { id: "b2", size: 5, tags: ["wide"] });
console.log(canvas.boxes.get("b1") === box, canvas.boxes.get("b2")?.tags?.length, canvas.boxes.size);
console.log(describe(box), describe(canvas.path[0]), describe(undefined));

const table: Boxes = { b1: box };
table["b3"] = { id: "b3", size: 8 };
console.log(Object.keys(table).join(","), table["b3"]?.size, table["missing"] === undefined);

const wrapped = sized<Point>({ x: 5, y: 6 }, { width: 2, height: 4 });
console.log(wrapped.value.y, area(wrapped.size), JSON.stringify(wrapped));

const settings: SettingsList = [{ name: "a" }, { name: "b", depth: 2 }];
canvas.settings = settings[1]!;
console.log(canvas.settings.depth, settings.map((s) => s.depth ?? 0).join("+"));

const point = JSON.parse('{"x":7,"y":8,"label":"parsed"}') as Point;
const boxes = JSON.parse('[{"id":"p1","size":1},{"id":"p2","size":2,"tags":["t"]}]') as Box[];
const parsedSettings = JSON.parse('{"name":"from text","depth":4}') as Settings;
console.log(point.x + point.y, point.label, boxes.length, boxes[1]!.tags?.join(""), parsedSettings.name);

interface LabelledSize extends Size {
  label: string;
}
const labelled: LabelledSize = { width: 1, height: 9, label: "tall" };
const tagged: Point & { tag: string } = { x: 0, y: 0, tag: "zero" };
console.log(area(labelled), labelled.label, tagged.tag, describe(tagged), JSON.stringify({ ...box, size: 4 }));
