// A JSDoc-typed target's storage follows the values the program writes with
// a plain assignment or an initializer (analyzeJsWidenedBindings and
// analyzeJsWidenedFields). A destructuring target and a `for`-of binding are
// writes those scans do not reach, so a value outside the annotation keeps
// the checker's refusal instead of failing in the lowering.
class Trio {
  constructor() {
    this.a = 1;
    this.b = 2;
    this.c = 3;
  }
}

/** @type {Trio} */
let scanned = new Trio();
for (scanned of [{ a: 1 }]) console.log(scanned.a);

/** @type {Trio} */
let destructured = new Trio();
[destructured] = [{ a: 2 }];
console.log(destructured.a);

/** @type {Trio} */
let keyed = new Trio();
({ a: keyed } = { a: { a: 3 } });
console.log(keyed.a);

class Holder {
  /** @type {Trio} */
  item = new Trio();
}
const holder = new Holder();
({ p: holder.item } = { p: { a: 4 } });
console.log(holder.item.a);
