// A string-literal union narrowed to `never` passes to a `never` parameter:
// the exhaustiveness-check idiom over if-chains and switches compiles, and the
// unreachable call never runs.

function unreachable(_: never): never {
  throw new Error("unreachable");
}

type Kind = "a" | "b";
function viaIf(kind: Kind): number {
  if (kind === "a") return 1;
  if (kind === "b") return 2;
  return unreachable(kind);
}

type Shape = "circle" | "square" | "triangle";
function corners(shape: Shape): number {
  switch (shape) {
    case "circle":
      return 0;
    case "square":
      return 4;
    case "triangle":
      return 3;
    default:
      return unreachable(shape);
  }
}

function asserted(kind: Kind): string {
  if (kind === "a" || kind === "b") return kind.toUpperCase();
  return unreachable(kind as never);
}

type Level = 1 | 2;
function viaNumbers(level: Level): string {
  if (level === 1) return "one";
  if (level === 2) return "two";
  return unreachable(level);
}

const kinds: Kind[] = ["a", "b"];
console.log(kinds.map(viaIf).join(","), viaIf(Date.now() > 0 ? "a" : "b"));
const shapes: Shape[] = ["circle", "square", "triangle"];
console.log(shapes.map(corners).join(","));
console.log(kinds.map(asserted).join(""), viaNumbers(1), viaNumbers(2));
