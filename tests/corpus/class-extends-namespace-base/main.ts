// `class Sub extends dep.Base`: a class named through a module namespace
// (the form compiled CommonJS packages write) is the base's class itself.
import * as dep from "./dep.ts";

class Sub extends dep.Base {
  extra(): string {
    return this.greet() + "-sub";
  }
}

// A string-literal member of the namespace is the same base, side-effect
// free: the heritage path admits it.
class Sub2 extends dep["Base"] {
  extra(): string {
    return this.greet() + "-sub2";
  }
}

const sub = new Sub();
console.log("ok", sub instanceof dep.Base, sub.extra());
console.log("ok2", new Sub2() instanceof dep.Base, new Sub2().extra());
