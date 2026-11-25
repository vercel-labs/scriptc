// Mixin edges the compiler rejects (tsc-clean, outside the subset): every
// fence names what blocks and points at the supported spelling.
type Ctor<T = object> = new (...args: any[]) => T;

class Base {
  n = 1;
}

function M<T extends Ctor<object>>(B: T) {
  return class extends B {
    m = 2;
  };
}

// A mixin call inside a function mints a DISTINCT class per call in JS —
// one immortal class object cannot be exact there.
function makeClass() {
  const X = M(Base);
  return new X();
}
console.log(makeClass().m);

// Builtin classes construct through libCalls, not thunks — they cannot
// sit under a mixin layer.
class E extends M(Error) {}
console.log(new E().m);

// Two same-shape instantiations are DISTINCT classes whose subtrees the
// intersection type cannot tell apart: instance types through the
// bindings stay unmapped rather than guess.
const A1 = M(Base);
const A2 = M(Base);
const a = new A1();
const b = new A2();
console.log(a.m + b.m);

// The mixin function read as a value erases to its dynamic closure (the
// alias binding registers, so calls through it still instantiate per site;
// the uninstantiated reference is the one function JavaScript has).
const held = M;
console.log(typeof held);

// A rest-parameter mixin constructor compiles only as the pure forwarding
// shape — anything else reads arguments no static signature carries.
function Sneaky<T extends Ctor<object>>(B: T) {
  class C extends B {
    argc: number;
    constructor(...args: any[]) {
      super(...args);
      this.argc = args.length;
    }
  }
  return C;
}
class S extends Sneaky(Base) {}
console.log(new S().argc);

// The base parameter's flow must be traceable: a mixin that stores or
// re-reads its parameter is dynamic base flow (recognition declines, and
// the call keeps the generic machinery's own fences).
function Leaky<T extends Ctor<object>>(B: T) {
  const saved = B;
  return class extends saved {
    l = 3;
  };
}
class L extends Leaky(Base) {}
console.log(new L().l);
