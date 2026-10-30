// Prototype reflection on an instance of a TypeScript function-local class
// without methods: one shared prototype per class evaluation.
function make(label: string): { label: string } {
  class Box {
    label = "";
  }
  const box = new Box();
  box.label = label;
  return box;
}
const a = make("a");
const b = make("b");
const pa = Object.getPrototypeOf(a);
console.log(pa === Object.getPrototypeOf(a), pa === Object.getPrototypeOf(b), typeof pa, Object.keys(a).join());
