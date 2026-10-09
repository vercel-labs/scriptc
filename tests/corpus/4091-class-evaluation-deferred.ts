// Class methods, instance fields, wrapped callbacks and computed-key
// method bodies only run when used, after every binding is initialized.
const Shelf = class {
  size = capacity;
  label(): string {
    return `${prefix} ${this.size}`;
  }
};
function wrap(read: () => number) {
  return function (): number {
    return read() * 2;
  };
}
const doubled = wrap(() => capacity);
const index = {
  [Symbol.iterator]() {
    return [prefix, String(capacity)][Symbol.iterator]();
  },
};
const capacity = 6;
const prefix = "shelf";
console.log(new Shelf().label(), doubled(), [...index].join(","));
