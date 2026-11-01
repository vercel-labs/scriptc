// Both operands of `instanceof` evaluate even when the answer is static:
// the target may be read through an object property or produced by a call.
'use strict';

class H {
  constructor() {
    this.t = 1;
  }
}
class G extends H {}
const registry = { H };
console.log("objprop:", new H() instanceof registry.H, new H() instanceof H);
function build() {
  return new H();
}
console.log("call:", build() instanceof H, build() instanceof registry.H);
console.log("inline:", new H() instanceof H, new H() instanceof G);
