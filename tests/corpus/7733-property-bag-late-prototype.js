// A class whose property bag is first created without prototype data, while a local
// class with an untyped base rewrites the shared bag dispatch: the store gains the
// prototype later, so inherited methods stay readable (hono's SmartRouter with zod).
function $constructor(name, initializer, params) {
  const Parent = params?.Parent ?? Object;
  class Definition extends Parent {}
  Object.defineProperty(Definition, "name", { value: name });
  function _(def) {
    const inst = params?.Parent ? new Definition() : this;
    inst.def = def;
    initializer(inst, def);
    return inst;
  }
  Object.defineProperty(_, "name", { value: name });
  return _;
}
class Smart {
  name = "S";
  #inner = [];
  constructor(init) { this.#inner = init.routers; }
  add(x) { this.#inner.push(x); }
  match(m) {
    const r = this.#inner[0];
    this.match = r.match.bind(r);
    this.name = `S + ${r.name}`;
    return "first " + m;
  }
}
class Inner { name = "Inner"; match(m) { return "inner " + m; } }
class App {
  router;
  constructor(options = {}) {
    const { strict, ...rest } = options;
    Object.assign(this, rest);
    this.router = options.router ?? new Smart({ routers: [new Inner()] });
  }
  dispatch(m) { return this.router.match(m); }
}
const app = new App();
console.log(Object.keys(app.router).join(","));
const $Err = $constructor("$Err", (inst, def) => { inst.issues = def.issues; }, { Parent: Error });
const e = new $Err({ issues: [1] });
console.log(Object.keys(e).join(","), e.issues.length);
const run = [(a) => a.dispatch("a"), (a) => a.dispatch("b")];
for (const f of run) console.log(f(app), app.router.name);
const holder = JSON.parse("{}");
holder.r = new Smart({ routers: [new Inner()] });
console.log(typeof holder.r.match, "match" in holder.r, Object.keys(holder.r).join(","));
console.log(holder.r.match("c"), holder.r.match("d"), holder.r.name);
const scratch = JSON.parse("{\"name\":\"x\",\"other\":1}");
delete scratch.name;
console.log(Object.keys(scratch).join(","));
