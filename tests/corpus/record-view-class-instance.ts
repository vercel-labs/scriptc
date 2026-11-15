// A class instance bound to a narrower record type is a view of the instance:
// the binding holds the object itself, so member reads, member writes and
// method calls through the record reach the instance, identity holds, and a
// method read as a value keeps its receiver.

class Counter {
  count = 0;
  label = "counter";

  bump(): void {
    this.count++;
  }

  describe(): string {
    return `${this.label}:${this.count}`;
  }
}

const counter = new Counter();
const view: { count: number; bump(): void } = counter;
console.log(view === counter, view.count);

view.count = 2;
view.bump();
console.log(view.count, counter.count, counter.describe());

const bump = view.bump;
console.log(typeof bump);

function add(target: { count: number }, by: number): void {
  target.count += by;
}
add(view, 5);
add(counter, 1);
console.log(counter.count, view.count);

// The same value through the declared class type and through the record view
// sees one field.
const values: { count: number } = counter;
values.count = 100;
console.log(counter.describe());
