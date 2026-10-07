type Shape =
  | { kind: "circle"; radius: number }
  | { kind: "square"; side: number }
  | { kind: "point" | "origin"; x: number; y: number }
  | { kind: "label"; text: string };

function area(shape: Shape): number {
  switch (shape.kind) {
    case "circle":
      return Math.round(shape.radius * shape.radius * 3.14);
    case "square":
      return shape.side * shape.side;
    case "origin":
    case "point":
      return 0;
    default:
      return -1;
  }
}

function describe(shape: Shape): string {
  let text = "";
  switch (shape.kind) {
    case "square":
      text += "four-sided ";
    // falls through
    case "circle":
      text += "closed";
      break;
    case "label":
      text += "text:" + shape.text;
      break;
    case "point":
      text += "point";
      break;
    case "circle":
      text += "unreachable duplicate";
  }
  return text || "other";
}

const shapes: Shape[] = [
  { kind: "circle", radius: 2 },
  { kind: "square", side: 3 },
  { kind: "point", x: 1, y: 2 },
  { kind: "origin", x: 0, y: 0 },
  { kind: "label", text: "hi" },
];
for (const shape of shapes) {
  console.log(
    shape.kind,
    area(shape),
    describe(shape),
    shape.kind === "circle",
    shape.kind !== "square",
    "origin" === shape.kind,
    shape.kind === "point",
  );
}

// A mutable discriminant on one arm is read from the object, not the tag.
type Token = { kind: "word" | "number"; text: string } | { kind: "end" };
const tokens: Token[] = [{ kind: "word", text: "x" }, { kind: "end" }];
const first = tokens[0]!;
if (first.kind !== "end") first.kind = "number";
for (const token of tokens) {
  switch (token.kind) {
    case "number":
      console.log("number", token.text);
      break;
    case "word":
      console.log("word", token.text);
      break;
    case "end":
      console.log("end");
  }
  console.log(token.kind === "number", token.kind === "end");
}
