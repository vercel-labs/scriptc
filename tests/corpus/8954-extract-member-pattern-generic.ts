// `Extract<U, { kind: K }>` inside a generic function is the member of U
// that K's bound literal selects, as TypeScript computes it for the call:
// an assertion to it narrows the union to that one member, and the function
// has one instance per literal, so each call's assertion follows its own.
type Circle = { kind: "circle"; radius: number };
type Square = { kind: "square"; side: number };
type Label = { kind: "label"; text: string; notes?: string };
type Shape = Circle | Square | Label;

const shapes = new Map<number, Shape>();
const find = <K extends Shape["kind"]>(id: number, kind: K): Extract<Shape, { kind: K }> | undefined => {
  const shape = shapes.get(id);
  return shape?.kind === kind ? (shape as Extract<Shape, { kind: K }>) : undefined;
};
shapes.set(0, { kind: "circle", radius: 1 });
shapes.set(1, { kind: "square", side: 2 });
shapes.set(2, { kind: "label", text: "top" });
const circle = find(0, "circle");
if (circle) circle.radius += 2;
const label = find(2, "label");
if (label) {
  label.text += "!";
  label.notes = "seen";
}
const square = find(1, "square");
console.log(square?.side, find(0, "square") === undefined, find(1, "square") === square);
console.log(JSON.stringify([...shapes.values()]));

// The assertion alone names the literal: the signature maps to the same
// types for every call, and each literal still has its own body.
function describe<K extends Shape["kind"]>(shape: Shape, kind: K): string {
  const picked = shape as Extract<Shape, { kind: K }>;
  return `${kind}:${JSON.stringify(picked)}`;
}
console.log(describe(shapes.get(0)!, "circle"));
console.log(describe(shapes.get(1)!, "square"));
console.log(describe(shapes.get(2)!, "label"));
// A parameter bound to several literals selects all of their members.
const kinds: Shape["kind"][] = ["label", "circle", "square"];
for (const kind of kinds) {
  for (const shape of shapes.values()) if (shape.kind === kind) console.log(describe(shape, kind));
}
// A parameter bound to two of the three literals selects those two members.
const pair: ("circle" | "label")[] = ["circle", "label"];
for (const kind of pair) console.log(describe(shapes.get(kind === "circle" ? 0 : 2)!, kind));

// A numeric literal and a second, fixed member in the pattern.
type Frame =
  | { op: 1; live: true; payload: string }
  | { op: 1; live: false; reason: string }
  | { op: 2; live: true; count: number };
function liveFrame<N extends Frame["op"]>(frame: Frame, op: N): string {
  if (frame.op !== op || !frame.live) return "skip";
  const live = frame as Extract<Frame, { op: N; live: true }>;
  return JSON.stringify(live);
}
const frames: Frame[] = [
  { op: 1, live: true, payload: "p" },
  { op: 1, live: false, reason: "closed" },
  { op: 2, live: true, count: 3 },
];
console.log(frames.map((frame) => liveFrame(frame, 1)).join(" "));
console.log(frames.map((frame) => liveFrame(frame, 2)).join(" "));

// `Exclude` by the same pattern is the rest of the union.
function others<K extends Shape["kind"]>(list: Shape[], kind: K): string {
  const out: string[] = [];
  for (const shape of list) {
    if (shape.kind === kind) continue;
    const rest = shape as Exclude<Shape, { kind: K }>;
    out.push(JSON.stringify(rest));
  }
  return out.join("|");
}
console.log(others([...shapes.values()], "circle"));
console.log(others([...shapes.values()], "label"));
