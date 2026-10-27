// Destructuring a program module's namespace, statically
// (`import * as ns`) and from a dynamic import: each element reads the
// export at the pattern's position — renames and defaults included — and
// binds a copy of its value (a later reassignment of an exported `let` is
// visible through the namespace, not through the binding). An annotation
// naming another module or an object type does not change which module's
// exports are read.
import * as ns from "./lib.ts";
import type * as shape from "./shape.ts";

const { add, label, counter, bump, Shape: Ctor } = ns;
console.log(add(2, 3), label, counter);
bump();
console.log(counter, ns.counter);
console.log(new Ctor(4).area());

async function main(): Promise<void> {
  const { add: plus, label: name = "unused" } = await import("./lib.ts");
  console.log(plus(10, 20), name);
  const { add: annotatedAdd, label: annotated }: typeof shape = await import("./lib.ts");
  console.log(annotatedAdd(10, 20), annotated);
}

const { add: shapeAdd, label: shapeLabel }: typeof shape = ns;
console.log(shapeAdd(2, 3), shapeLabel);
const { label: viaObject }: { label: string } = ns;
console.log(viaObject);

main();
