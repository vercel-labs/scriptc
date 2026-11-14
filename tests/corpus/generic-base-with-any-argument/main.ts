import { Defaulted, Written } from "./app.js";
import { Abstract, Base, Mid, Pair } from "./model.ts";

// Leaving the argument off applies the `any` default; the class still has a
// concrete layout, so it constructs and its inherited members lower.
class Sub extends Base {}
class Span extends Base<any> {
  extra = 2;
}
class Concrete extends Base<{ a: number }> {}
class Leaf extends Mid<any> {}
class Mixed extends Pair<any, number> {}

const sub = new Sub(1);
console.log("default", sub.props, sub.describe(), sub instanceof Base, sub instanceof Sub);

const span = new Span();
span.props = "tagged";
console.log("written", span.props, span.extra, span.describe(), span instanceof Base);

const concrete = new Concrete();
concrete.props = { a: 3 };
console.log("concrete", concrete.props.a, concrete.describe());

const leaf = new Leaf();
leaf.props = 5;
console.log("mid", leaf.describe(), leaf instanceof Base, leaf instanceof Mid);

const mixed = new Mixed();
mixed.first = "s";
mixed.second = 2;
console.log("mixed", mixed.summary(), mixed instanceof Pair);

class Impl extends Abstract {
  label(): string {
    return "impl";
  }
}
const impl = new Impl();
impl.props = "p";
console.log("abstract", impl.show(), impl instanceof Abstract);

// A value typed at the family still answers what every instantiation shares,
// and one built from the `any` instantiation upcasts into it.
const family: Base<any> = sub;
const spans: Base<any>[] = [sub, span, leaf];
console.log("family", family === sub, spans.length, spans[1] === span);

const defaulted = new Defaulted();
console.log("js default", defaulted.props, defaulted.describe(), defaulted instanceof Defaulted);
defaulted.props = "set";
console.log("js default set", defaulted.describe());

const written = new Written();
console.log(
  "js written",
  written.props,
  written.extra,
  written.describe(),
  written instanceof Written,
);

class Child extends Impl {
  show(): string {
    return `child:${super.show()}`;
  }
}
const child = new Child();
child.props = 9;
console.log("child", child.show(), child instanceof Abstract);
