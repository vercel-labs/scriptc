// A class built in an argument position whose static initializers run code:
// JavaScript evaluates the callee and the earlier arguments first, then the
// class (its static initializers included), then the call. A callee and
// arguments that run no code and read nothing the program writes leave that
// order unchanged.

class Base {
  v = 1;
}

function Tagged(B: typeof Base) {
  return class extends B {
    static tag = (console.log("Tagged statics"), "tagged");
  };
}

function register(name: string, C: typeof Base): void {
  console.log("register", name, C.name, new C().v);
}

const registry = {
  names: [] as string[],
  define(name: string, C: typeof Base): void {
    this.names.push(name);
    console.log("define", name, new C().v);
  },
};

const first = "x-one";
console.log("start");
register(first, Tagged(Base));
registry.define(
  "x-two",
  class Two extends Base {
    static tag = (console.log("Two statics"), "two");
    v = 2;
  },
);
console.log(registry.names.join(","));
