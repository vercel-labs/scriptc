// Object.defineProperty can change a declared class field's value and
// attributes, but not turn it into an accessor: a literal get or set
// descriptor is refused at compile time, naming the field.
class Value {
  x = 1;
}

const value = new Value();
Object.defineProperty(value, "x", {
  get() {
    return 2;
  },
});
console.log(value.x);
