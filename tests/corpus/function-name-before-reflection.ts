// Reflection can be the first operation on a function, and the property
// table it creates takes the function's `name` from the box that creates it.
// The descriptor reads after the reflection must answer what the read before
// it did, for a declared function and for a method value, whose closure has
// no name of its own in the module's closure-name table.
class Counter {
  count = 0;
  bump(): void {
    this.count++;
  }
}

const counter = new Counter();
const bump = counter.bump;
const before = Object.getOwnPropertyDescriptor(bump, "name");
console.log("method before", JSON.stringify(before ? before.value : null));
Object.getOwnPropertyNames(bump);
const after = Object.getOwnPropertyDescriptor(bump, "name");
console.log("method after", JSON.stringify(after ? after.value : null));

function declared(): void {}
const declaredBefore = Object.getOwnPropertyDescriptor(declared, "name");
console.log("declared before", JSON.stringify(declaredBefore ? declaredBefore.value : null));
Object.getOwnPropertyNames(declared);
const declaredAfter = Object.getOwnPropertyDescriptor(declared, "name");
console.log("declared after", JSON.stringify(declaredAfter ? declaredAfter.value : null));
