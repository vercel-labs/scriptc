// @ts-check
// A JavaScript override that narrows a class-typed parameter (TypeScript
// admits it through method bivariance) and a base-typed reference that calls
// it: the base declaration and the override share one boxed parameter ABI, so
// the call converts its argument once and the override reads the value it
// would read in Node, where a plain point simply has no `z`.
class Point {
  constructor() {
    this.x = 1;
  }
  get label() {
    return "point";
  }
}
class Point3D extends Point {
  constructor() {
    super();
    this.z = 2;
  }
}
class Base {
  /** @param {Point} value */
  describe(value) {
    return "base " + value.label + " " + value.x;
  }
}
class Sub extends Base {
  /** @param {Point3D} value */
  describe(value) {
    return "sub " + value.label + " " + value.z;
  }
}
const base = /** @type {Base} */ (new Sub());
console.log(base.describe(new Point()));
console.log(base.describe(new Point3D()));
console.log(new Sub().describe(new Point3D()));
