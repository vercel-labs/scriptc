"use strict";
// RegExp.prototype.compile has no lowering: the call is a deferred refusal,
// thrown where it runs and caught here.
export function recompile(n) {
  try {
    const target = new RegExp("a");
    target.compile("b");
    return 1;
  } catch {
    return n;
  }
}
