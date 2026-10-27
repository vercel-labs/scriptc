// Top-level `this` in an ES module stays undefined, also inside arrow
// functions at module scope.
const arrow = () => this;
console.log(typeof this, this === undefined, typeof arrow());
