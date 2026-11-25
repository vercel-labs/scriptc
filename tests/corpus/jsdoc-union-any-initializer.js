class Base {
  constructor() {
    this.kind = 0;
  }
}
class Other {
  constructor() {
    this.other = 1;
  }
}
function pick(v) {
  /** @type {Base | undefined} */
  const b = v;
  return b;
}
console.log(pick(undefined) === undefined);
console.log(pick(new Base()) === undefined);
console.log(pick(new Other()) === undefined);
console.log(pick(new Other()) instanceof Other);
console.log(pick(0) === undefined);
