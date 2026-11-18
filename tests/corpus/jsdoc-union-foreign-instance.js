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
/** @type {Base | undefined} */
let b;
const o = new Other();
b = o;
console.log(b === undefined);
console.log(b === o);
console.log(b instanceof Other);
console.log(b instanceof Base);
b = new Base();
console.log(b instanceof Base);
console.log(b === o);
