// DisposableStack: use, adopt, defer, move and dispose with class instances,
// object literals and callbacks; LIFO disposal; SuppressedError chains;
// Node's ReferenceError and TypeError texts; using over a stack; inspection;
// and stacks whose callbacks capture the stack. Node.js prints the same.
const log: string[] = [];
class Resource {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
  [Symbol.dispose](): void {
    log.push("dispose " + this.name);
  }
}
class Failing {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
  [Symbol.dispose](): void {
    throw new Error("fail " + this.name);
  }
}
function scope(): void {
  using stack = new DisposableStack();
  const a = stack.use(new Resource("a"));
  log.push("got " + a.name);
  stack.defer(() => log.push("deferred"));
  const n = stack.adopt(42, (v) => log.push("adopted " + v));
  const r = stack.adopt(new Resource("adopted-res"), (v) => log.push("adopt " + v.name));
  stack.use({ [Symbol.dispose]() { log.push("literal"); } });
  stack.use(null);
  stack.use(undefined);
  log.push("n=" + n + " r=" + r.name + " disposed=" + stack.disposed);
}
scope();
console.log(log.join("\n"));
log.length = 0;

const outer = new DisposableStack();
outer.use(new Resource("x"));
const moved = outer.move();
console.log(outer.disposed, moved.disposed, outer instanceof DisposableStack, moved instanceof DisposableStack);
moved.dispose();
moved.dispose();
console.log(log.join(","), moved.disposed);
log.length = 0;

function attempt(label: string, f: () => void): void {
  try {
    f();
    console.log(label, "ok");
  } catch (e) {
    if (e instanceof SuppressedError) {
      const chain: string[] = [];
      let cur: unknown = e;
      while (cur instanceof SuppressedError) {
        chain.push((cur.error as Error).message);
        cur = cur.suppressed;
      }
      chain.push(cur instanceof Error ? cur.message : String(cur));
      console.log(label, "SuppressedError", e.message, chain.join(" <- "));
    } else if (e instanceof Error) {
      console.log(label, e.name, e.message);
    } else {
      console.log(label, "thrown", e);
    }
  }
}
attempt("three failures", () => {
  const s = new DisposableStack();
  s.use(new Failing("one"));
  s.defer(() => { throw new Error("two"); });
  s.use(new Failing("three"));
  s.dispose();
});
attempt("single", () => {
  const s = new DisposableStack();
  s.use(new Resource("before"));
  s.defer(() => { throw new RangeError("only"); });
  s.dispose();
});
console.log(log.join(","));
attempt("thrown value", () => {
  const s = new DisposableStack();
  s.defer(() => { throw 7; });
  s.dispose();
});
attempt("using body error", () => {
  using s = new DisposableStack();
  s.defer(() => { throw new Error("disposal"); });
  throw new Error("body");
});
const done = new DisposableStack();
done.dispose();
attempt("use after dispose", () => { done.use(new Resource("late")); });
attempt("defer after dispose", () => done.defer(() => {}));
attempt("adopt after dispose", () => { done.adopt(1, () => {}); });
attempt("move after dispose", () => { done.move(); });
attempt("dispose twice", () => done.dispose());
attempt("use non-object", () => { new DisposableStack().use(5 as unknown as Disposable); });
attempt("use missing method", () => { new DisposableStack().use({} as unknown as Disposable); });
attempt("defer non-function", () => new DisposableStack().defer(3 as unknown as () => void));
attempt("adopt non-function", () => { new DisposableStack().adopt(1, "x" as unknown as () => void); });
const reentrant = new DisposableStack();
reentrant.defer(() => {
  console.log("inside disposed", reentrant.disposed);
  attempt("defer during dispose", () => reentrant.defer(() => {}));
});
reentrant.dispose();
const shown = new DisposableStack();
console.log(shown, String(shown), Object.prototype.toString.call(shown), typeof shown, JSON.stringify(shown));
const self = new DisposableStack();
self.defer(() => console.log("self disposed", self.disposed));
self[Symbol.dispose]();
const nested = new DisposableStack();
const inner = nested.use(new DisposableStack());
inner.defer(() => console.log("inner via outer"));
nested.dispose();
console.log(inner.disposed);
class Base {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
  [Symbol.dispose](): void {
    console.log("base dispose", this.name);
  }
}
class Derived extends Base {
  override [Symbol.dispose](): void {
    console.log("derived dispose", this.name);
  }
}
class Plain extends Base {}
const inherit = new DisposableStack();
const items: Base[] = [new Derived("d"), new Plain("p"), new Base("b")];
for (const item of items) inherit.use(item);
const back = inherit.use(new Derived("returned"));
console.log(back.name, back instanceof Derived);
inherit.dispose();
// A stack whose callback captures the stack is collected without disposal.
for (let i = 0; i < 3; i++) {
  const cyc = new DisposableStack();
  cyc.defer(() => console.log("never", cyc.disposed));
}
const holder = { stack: new DisposableStack() };
console.log(holder, [holder.stack]);
function make(): DisposableStack {
  const st = new DisposableStack();
  st.defer(() => console.log("made stack disposed"));
  return st;
}
{
  using made = make();
  console.log("in block", made.disposed);
}
