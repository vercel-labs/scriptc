class Vector {
  x = 0;
  length(): number { return this.x; }
}
// Named slots are represented; a prototype held by a binding that could write it is not.
let escaped = Vector.prototype;
// End of the prototype reflection diagnostic fixture.
