// A checked view of a class instance whose property is a prototype
// accessor. The view is the instance itself: reading it after the class
// changes shows the new value, and the view still prints, serializes and
// lists its fields.
class Counter {
  private count = 0;
  get value(): number {
    return this.count;
  }
  set value(v: number) {
    this.count = v;
  }
  bump(): void {
    this.count++;
  }
}

const counter = new Counter();
const view = counter as unknown as { value: number };
console.log(view.value);
counter.bump();
console.log(view.value, `${JSON.stringify(view)}`, Object.keys(view));
view.value = 7;
console.log(counter.value, view.value, Object.is(counter, view));
console.log(view);
console.log(Object.entries(view));
