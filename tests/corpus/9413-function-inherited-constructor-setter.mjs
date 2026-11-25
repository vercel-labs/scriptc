// `fn.constructor = value` on a function that inherits an accessor named
// `constructor` from the object its prototype was set to: the setter runs
// with the function as its receiver, and the function gets no property of
// its own. A function without such an accessor takes the write as its own
// property (9412).
function make() {
  const made = () => 'made';
  return made;
}

const fn = make();
let seen = 'unset';
let got;
const proto = {
  get constructor() {
    return 'inherited';
  },
  set constructor(value) {
    seen = this === fn ? 'the function' : typeof this;
    got = value;
  },
};
Object.setPrototypeOf(fn, proto);
fn.constructor = 7;
console.log(seen, got, fn.constructor, Object.getOwnPropertyNames(fn).includes('constructor'));

// The accessor one step further up.
const other = make();
Object.setPrototypeOf(other, Object.create(proto));
seen = 'unset';
other.constructor = 9;
console.log(seen === 'the function' ? 'not this one' : seen, got, other.constructor);

const plain = make();
plain.constructor = 8;
console.log(plain.constructor, Object.getOwnPropertyNames(plain).includes('constructor'), fn());
