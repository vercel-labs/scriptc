import { Base, plain, tagged } from "./base.ts";

// A class statement's heritage may compute its base at run time: the
// conditional is evaluated once, where the class statement runs, and the class
// extends the class value it selects.
const config = { form: false };
class Form extends (config.form ? tagged(Base) : Base) {
  own = 3;
}
console.log(new Form().v + new Form().own, new Form() instanceof Base);

const form = { enabled: true };
class Tagged extends (form.enabled ? tagged(Base) : Base) {
  own = 4;
}
console.log(new Tagged().doubled(), new Tagged().own, new Tagged() instanceof Base);

// A conditional over two classes where one extends the other: the class takes
// the shape of the type both arms share, and either arm constructs.
class Sub extends Base {}
const derived = { pick: true };
class Pick extends (derived.pick ? Sub : Base) {
  own = 5;
}
const picked = new Pick();
console.log(picked.v, picked.doubled(), picked.own);
console.log(picked instanceof Base);

// The same class on both arms.
class Same extends (derived.pick ? Base : Base) {
  own = 6;
}
console.log(new Same().v + new Same().own);

// The heritage's side effects run once, at the class statement, not on each
// construction.
let evaluations = 0;
function counted(B: typeof Base) {
  evaluations++;
  return class extends B {};
}
const once = { make: false };
class Once extends (once.make ? counted(Base) : Base) {
  own = 7;
}
new Once();
new Once();
console.log(evaluations, new Once().own);

// A directly-called mixin heritage keeps the mixin's whole instance shape.
class Direct extends plain(Base) {
  own = 8;
}
const direct = new Direct();
console.log(direct.v + direct.own, (direct as any).extra, direct.doubled());

// A class expression computes its heritage the same way.
const Expression = class extends (form.enabled ? tagged(Base) : Base) {
  own = 9;
};
console.log(new Expression().v + new Expression().own, new Expression() instanceof Base);
