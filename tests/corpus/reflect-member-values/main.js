// The Reflect namespace's function members, read as values and called
// through that value: Node's functions with Node's names and lengths.
console.log(typeof Reflect.construct, typeof Reflect.defineProperty, typeof Reflect.setPrototypeOf);
console.log(Reflect.construct.length, Reflect.defineProperty.length, Reflect.setPrototypeOf.length);

function C(x) {
  this.x = x;
}
const made = Reflect.construct(C, [7]);
console.log(made instanceof C, made.x);
console.log(Reflect.construct === Reflect.construct, Reflect.construct.name);

const o = {};
console.log(Reflect.defineProperty(o, 'k', { value: 5, enumerable: true }), o.k);

const base = { p: 1 };
const target = {};
console.log(Reflect.setPrototypeOf(target, base), target.p, Object.getPrototypeOf(target) === base);

const frozen = Object.preventExtensions({});
console.log(Reflect.setPrototypeOf(frozen, base));
console.log(Reflect.setPrototypeOf(frozen, Object.getPrototypeOf(frozen)));

const members = [];
for (const name of ['construct', 'defineProperty', 'setPrototypeOf']) {
  const held = Reflect[name];
  members.push(typeof held === 'function');
}
console.log(members.join(','));
console.log(Object.keys(Reflect).length, Object.prototype.toString.call(Reflect));
