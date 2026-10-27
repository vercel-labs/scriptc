// A class instance held in a binding that asserts a possibly undefined
// value (`const node = stack.pop()!`) keeps that undefined at run time.
// Asserting the binding to a view of the class (`node as unknown as View`)
// gives the same live instance a direct cast does: getters run on each
// read, the view is the instance for identity, and an undefined value
// stays undefined until a property read throws Node's TypeError.
interface View {
  readonly kind: number;
  readonly label: string;
}

abstract class Base {
  reads = 0;
  abstract get kind(): number;
  get label(): string {
    this.reads++;
    return `node${this.kind}`;
  }
}

class Leaf extends Base {
  private readonly value: number;
  constructor(value: number) {
    super();
    this.value = value;
  }
  get kind(): number {
    return this.value;
  }
}

class Branch extends Base {
  get kind(): number {
    return 10;
  }
}

function walk(roots: Base[], cb: (node: View) => void): void {
  while (roots.length > 0) {
    const node = roots.pop()!;
    cb(node as unknown as View);
  }
}

const asView = (node: Base): View => node as unknown as View;

function walkWith(roots: Base[], cb: (node: View) => void): void {
  while (roots.length > 0) {
    const node = roots.pop()!;
    cb(asView(node));
  }
}

const seen: View[] = [];
let total = 0;
const leaf = new Leaf(2);
walk([new Leaf(1), leaf, new Branch()], (view) => {
  total += view.kind;
  seen.push(view);
});
console.log(total, seen.map((view) => view.label).join(","));
console.log(seen.includes(leaf as unknown as View), leaf.reads);

const labels: string[] = [];
walkWith([new Branch(), new Leaf(3)], (view) => labels.push(`${view.kind}:${view.label}`));
console.log(labels.join(" "));

function first(roots: Base[]): View {
  const node = roots.pop()!;
  return node as unknown as View;
}
const missing = first([]);
console.log(missing === undefined);
try {
  console.log(missing.kind);
} catch (error) {
  console.log(error instanceof TypeError, (error as Error).message);
}
