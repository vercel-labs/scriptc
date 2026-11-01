// util.inspect with showHidden lists inherited properties the way Node's
// prototype walk reaches them: a user-defined prototype contributes its own
// keys after the object's own ones, the nearest layer wins, at most three
// layers are read, function values are skipped, and symbols and accessors
// print in Node's form. The entries follow the object's own keys and respect
// sorted and depth, a property that points back at the
// object prints as [Circular *N], and the builtin prototypes
// (Object.prototype, Array.prototype) contribute nothing.
import * as util from "node:util";

const show = (value: unknown, options: util.InspectOptions = { showHidden: true }): void =>
  console.log(util.inspect(value, options));

const created = Object.create({ x: 1 });
show(created);
show(created, {});
show(created, { showHidden: false });

const proto: Record<string, unknown> = { x: 1 };
const variable = Object.create(proto);
proto.later = 9;
show(variable);

const one: Record<string, unknown> = { one: 1 };
const two = Object.create(one);
two.two = 2;
const three = Object.create(two);
three.three = 3;
const four = Object.create(three);
four.four = 4;
show(four);
four.one = 0;
show(four);
show(Object.create(four));

show(Object.create({ b: 1, a: 2 }), { showHidden: true, sorted: true });
show(Object.create({ b: { c: 1 } }), { showHidden: true, depth: 1 });
show(Object.create({ b: { c: 1 } }), { showHidden: true, depth: 0 });
show([Object.create({ x: 1 })]);
show({ k: Object.create({ x: 1 }) });

show(Object.create({ fn() {}, value: 2 }));

const sym = Symbol("s");
const host: Record<string | symbol, unknown> = { plain: 1 };
host[sym] = 2;
show(Object.create(host));
show(Object.create(host), { showHidden: true, sorted: true });

const set = { own: 3 } as Record<string, unknown>;
Object.setPrototypeOf(set, { x: 1 });
show(set);
const empty: Record<string, unknown> = {};
Object.setPrototypeOf(empty, { x: 1 });
show(empty);

const nestedGetter = {
  get g() {
    return 3;
  },
  v: 4,
};
show(Object.create(nestedGetter));

console.log(util.inspect(Object.create(Object.prototype), { showHidden: true }));

const back: Record<string, unknown> = {};
const ring = Object.create(back);
back.self = ring;
show(ring);

const heldOptions: util.InspectOptions = { showHidden: true };
show(Object.create({ x: 1 }), heldOptions);
