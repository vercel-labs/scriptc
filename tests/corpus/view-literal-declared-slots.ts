// A literal with no accessor that flows into a checked-identity view (a type
// a class implements, or one another literal implements with an accessor) is
// a record seen by live reference. The record has the declared type's slots:
// a member initialised to `null` or `[]` takes the values the declared type
// admits, and a member the declared type makes optional and the literal
// leaves out can be set later.

interface Shape {
  name: string | null;
  sides: number[];
  note?: string;
  area(): number;
}
class Square implements Shape {
  name: string | null = "square";
  sides: number[] = [1, 1, 1, 1];
  note?: string;
  area(): number {
    return 1;
  }
}
function unit(): Shape {
  return { name: null, sides: [], area: () => 0 };
}
const bound: Shape = { name: null, sides: [], area: () => 0 };
class Holder {
  shape: Shape = { name: null, sides: [], area: () => 0 };
}
function keep(shape: Shape): Shape {
  return shape;
}

function rename(shape: Shape, name: string): void {
  shape.name = name;
  shape.sides.push(2);
  const held = shape.sides;
  held.push(3);
  shape.note = `${name}!`;
  console.log("one array", held === shape.sides);
}

const shapes = [
  new Square(),
  unit(),
  bound,
  new Holder().shape,
  keep({ name: null, sides: [], area: () => 0 }),
];
for (const shape of shapes) {
  console.log(shape.name, shape.sides.join(","), shape.note, shape.area(), "note" in shape);
  rename(shape, "renamed");
  console.log(shape.name, shape.sides.join(","), shape.note, shape.area(), "note" in shape);
  shape.sides = [9];
  const held = shape.sides;
  held.push(8);
  console.log(shape.sides.join(","), Object.keys(shape).join(","), JSON.stringify(shape));
}

// The same for a type that is a view because one literal implements a member
// with a getter: the literals with a plain member share the declared type.
interface Msg {
  text: string;
}
interface Box {
  readonly size: number;
  current?: Msg;
  tags: string[];
  meta: { tag?: string; depth: number | null };
}
let n = 1;
function live(): Box {
  return {
    get size() {
      return n;
    },
    current: undefined,
    tags: [],
    meta: { tag: undefined, depth: null },
  };
}
function fixed(): Box | undefined {
  return { size: 3, current: undefined, tags: [], meta: { depth: null } };
}
const plain: Box = { size: 4, tags: [], meta: { depth: null } };
function fill(box: Box, text: string): void {
  box.current = { text };
  box.tags.push(text);
  const held = box.tags;
  held.push(`${text}!`);
  box.meta.tag = text;
  const meta = box.meta;
  meta.depth = text.length;
}
for (const box of [live(), fixed(), plain]) {
  if (box === undefined) continue;
  fill(box, "ab");
  n++;
  console.log(box.size, box.current?.text, box.tags.join(","), JSON.stringify(box));
  console.log(Object.keys(box).join(","));
}
