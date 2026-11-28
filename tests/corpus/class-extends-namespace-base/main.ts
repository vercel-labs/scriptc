// `class Sub extends dep.Base`: a class named through a module namespace
// (the form compiled CommonJS packages write) is the base's class itself.
import * as dep from "./dep.ts";

class Sub extends dep.Base {
  extra(): string {
    return this.greet() + "-sub";
  }
}

const sub = new Sub();
console.log("ok", sub instanceof dep.Base, sub.extra());
