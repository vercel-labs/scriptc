// `const classes = [A, B]`: tsc's best common type spells the FIRST
// constructor, but the literal is a fresh array of every constructor it
// names, so element reads must see the constructor the slot actually holds
// (construct, iterate, and test with `instanceof`).
'use strict';

class First {
  constructor() {
    this.tag = "first";
  }
}
class Second {
  constructor() {
    this.tag = "second";
  }
}
const classes = [First, Second];
console.log("length:", classes.length);
console.log("construct:", new classes[0]().tag, new classes[1]().tag);
console.log("instanceof:", new First() instanceof classes[0], new Second() instanceof classes[1]);
for (const C of classes) console.log("loop:", new C().tag);

function tags() {
  class A {
    constructor() {
      this.tag = "a";
    }
  }
  class B {
    constructor() {
      this.tag = "b";
    }
  }
  const both = [A, B];
  const out = [];
  for (const C of both) out.push(new C().tag);
  out.push(new B() instanceof both[1] ? "b-inst" : "b-miss");
  return out.join(",");
}
console.log("local:", tags());
