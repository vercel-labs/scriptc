// @tsc-legacy-decorators
// Legacy (`experimentalDecorators`) class decorators: the class definition,
// its heritage, static field initializers and static blocks run BEFORE the
// first decorator expression evaluates; the factories then evaluate in
// source order; applications run in REVERSE order over the class value. A
// decorator's write through its parameter sticks because the static
// initializers have already run (the standard semantics run them after).

function make(label: string): (t: typeof Widget) => void {
  console.log("factory", label);
  return (t: typeof Widget) => {
    console.log("apply", label, t.name);
  };
}

function stamp(t: typeof Widget): void {
  t.stamped = true;
  console.log("stamp", t.name, t.stamped);
}

// A replacing decorator: it returns the class itself, so the binding keeps
// one identity and every direct path stays exact.
function identity(t: typeof Widget): typeof Widget {
  console.log("identity", t.name);
  return t;
}

class Base {
  kind(): string {
    return "base";
  }
}

console.log("before");

@make("outer")
@stamp
@identity
@make("inner")
class Widget extends Base {
  static stamped = false;
  static init = (console.log("static field"), 7);
  static {
    console.log("static block", Widget.stamped, Widget.init);
  }
  kind(): string {
    return "widget";
  }
}

// stamped is TRUE: the decorator ran after `stamped = false`.
console.log("after", Widget.stamped, Widget.init, Widget.name);
const w = new Widget();
console.log("instance", w.kind(), w instanceof Widget, w instanceof Base);
const alias = Widget;
console.log("alias", alias === Widget, typeof Widget);
