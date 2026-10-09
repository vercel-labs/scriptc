// Field reads through indexed array elements: parameters, locals, fields and
// module-level arrays, dense and sparse, with holes that must still throw a
// TypeError at the read, and reference fields that must outlive the array.
class Part {
  parent: Part | undefined = undefined;
  weight: number;
  label: string;
  constructor(weight: number, label: string) {
    this.weight = weight;
    this.label = label;
  }
}

function build(count: number): Part[] {
  const parts: Part[] = [];
  for (let i = 0; i < count; i++) {
    const part = new Part(i % 7, `p${i}`);
    if (i > 0) part.parent = parts[(i - 1) >> 1];
    parts.push(part);
  }
  return parts;
}

function heavy(parts: Part[]): number {
  let n = 0;
  for (let i = 0; i < parts.length; i++) if (parts[i].weight > 3) n++;
  return n;
}

function parentWeights(parts: Part[]): number {
  let total = 0;
  for (let i = 0; i < parts.length; i++) {
    const parent = parts[i].parent;
    if (parent !== undefined) total += parent.weight;
  }
  return total;
}

class Shelf {
  readonly parts: Part[];
  constructor(parts: Part[]) {
    this.parts = parts;
  }
  labels(step: number): string {
    let out = "";
    for (let i = 0; i < this.parts.length; i += step) out += this.parts[i].label + " ";
    return out.trim();
  }
}

function weightAt(parts: Part[], index: number): number {
  return parts[index].weight;
}

const parts = build(64);
console.log("heavy", heavy(parts), "parents", parentWeights(parts));
console.log("labels", new Shelf(parts).labels(9));

let local = 0;
for (let r = 0; r < 3; r++) for (let i = 0; i < parts.length; i++) local += parts[i].weight;
console.log("module total", local);

const sparse: Part[] = [];
sparse[2] = new Part(5, "late");
console.log("sparse", weightAt(sparse, 2), sparse[2].label);
for (const index of [0, 5, -1]) {
  try {
    console.log("unexpected", weightAt(sparse, index));
  } catch (e) {
    console.log("hole", index, e instanceof TypeError);
  }
}
try {
  console.log("unexpected", parts[parts.length].label);
} catch (e) {
  console.log("past the end", e instanceof TypeError);
}

// A reference read through an element survives clearing the array.
const kept = parts[10].parent;
parts.length = 0;
console.log("kept", kept?.label, kept?.parent?.label, parts.length);
