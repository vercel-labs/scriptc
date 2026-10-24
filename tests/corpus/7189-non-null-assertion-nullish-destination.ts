// `!` has no runtime effect: a value asserted non-null that still holds
// null or undefined reaches a return value, an arrow function's result or
// an argument whose declared type holds it (or is any or unknown), unchanged.
interface Shape {
  size: number;
}

const shapes = new Map<string, Shape | null>();
function shapeOf(key: string): Shape | null {
  if (shapes.has(key)) return shapes.get(key)!;
  const result = key.length > 3 ? { size: key.length } : null;
  shapes.set(key, result);
  return result;
}
console.log(shapeOf("ab"), shapeOf("abcd"));
console.log(shapeOf("ab"), shapeOf("abcd"), shapes.size);

const counts = new Map<string, number>([["a", 1]]);
function countOf(key: string): number | undefined {
  return counts.get(key)!;
}
console.log(countOf("a"), countOf("b"));

function describe(shape: Shape | null): string {
  return shape === null ? "none" : `size ${shape.size}`;
}
console.log(describe(shapes.get("ab")!), describe(shapes.get("abcd")!));

class Slot {
  readonly label: string;
  constructor(shape: Shape | null) {
    this.label = shape === null ? "empty" : `slot ${shape.size}`;
  }
}
console.log(new Slot(shapes.get("ab")!).label, new Slot(shapes.get("abcd")!).label);

const lookup = (key: string): Shape | null => shapes.get(key)!;
console.log(lookup("ab"), lookup("abcd")?.size);

const names = new Map<string, string | null>([["a", null], ["b", "bee"]]);
const amounts = new Map<string, number | undefined>([["a", undefined], ["b", 2]]);
function kindOf(value: unknown): string {
  return value === null ? "null" : typeof value;
}
console.log(String(names.get("a")!), String(names.get("b")!));
console.log(Number(amounts.get("a")!), Number(amounts.get("b")!));
console.log(kindOf(names.get("a")!), kindOf(amounts.get("a")!), kindOf(names.get("b")!));

// TextDecoder.decode reads the asserted Uint8Array; an undefined input
// decodes no bytes (text-decoder-undefined-input.ts).
const chunks = new Map<string, Uint8Array | undefined>([["a", new TextEncoder().encode("chunk")]]);
interface Read {
  done: boolean;
  value?: Uint8Array;
}
const read: Read = { done: false, value: chunks.get("a") };
console.log(new TextDecoder().decode(chunks.get("a")!), new TextDecoder().decode(read.value!).slice(0, 3));
