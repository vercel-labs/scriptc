// A reflected accessor read whose receiver is a call expression evaluates
// the call once, as in Node.
class Reading {
  value = 1;
  get scale(): number {
    return this.value * 2;
  }
}
Object.defineProperty(Reading.prototype, "scale", {
  get(this: Reading) {
    return this.value * 3;
  },
  configurable: true,
});
let constructions = 0;
function make(value: number): Reading {
  constructions++;
  const made = new Reading();
  made.value = value;
  return made;
}
console.log(make(2).scale, constructions);
console.log(make(5).scale, constructions);
