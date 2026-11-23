// Fields of an instance of a class that extends Array, written from sloppy-
// mode code: a variable-key write reaches the field or its setter, and once
// Object.freeze froze the instance, every write (named, keyed, typed) is
// skipped without an error, as in Node.
class Listy extends Array {
  label = "L";
  #n = 0;
  get count() {
    return this.#n;
  }
  set count(v) {
    this.#n = v * 10;
  }
}

function write(value, key, v) {
  value[key] = v;
}

function run() {
  const live = [new Listy()];
  const d = live[0];
  write(d, "label", "M");
  write(d, "count", 2);
  console.log(d.label, d.count, live[0].label);

  const f = new Listy();
  f.push(1);
  Object.freeze(f);
  const held = [f][0];
  held.label = "named";
  console.log("after named", f.label);
  write(held, "label", "keyed");
  console.log("after keyed", f.label);
  f.label = "typed";
  console.log("after typed", f.label, Object.isFrozen(f), f.length);

  // Frozen through an untyped parameter: the same writes are skipped.
  const g = new Listy();
  freezeUntyped([g][0]);
  write([g][0], "label", "keyed");
  write([g][0], "count", 5);
  [g][0].label = "named";
  console.log("after untyped freeze", g.label, g.count, Object.isFrozen(g));
}
function freezeUntyped(value) {
  Object.freeze(value);
}
run();
