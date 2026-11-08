// An assignment to a function walks the function's prototype chain, and an
// accessor found anywhere on it runs with the function that was assigned
// to as `this`: whether the accessor's holder is the function's direct
// prototype or is reached through other functions and objects. A data
// property met first shadows the accessor, and the write is then the
// function's own property. `constructor` is the name a function also
// inherits from Function.prototype; `gain` is a name with no such history.
const heard = [];
const labels = [];
const labelOf = (value) => {
  for (const pair of labels) if (pair[1] === value) return pair[0];
  return typeof value;
};
const tag = (label, value) => {
  labels.push([label, value]);
};
// A read of the name through a value the checker does not type: the
// functions' own types take the name from the values assigned below.
const named = (value) => value.constructor;

const ground = {
  get constructor() {
    return `ground's, read by ${labelOf(this)}`;
  },
  set constructor(value) {
    heard.push(`${labelOf(this)} takes ${value}`);
  },
  set gain(value) {
    heard.push(`${labelOf(this)} gains ${value}`);
  },
};
tag('ground', ground);

function relay() {}
tag('relay', relay);
Object.setPrototypeOf(relay, ground);
function second() {}
tag('second', second);
Object.setPrototypeOf(second, relay);

// One step up, through one function, through two, and with an object between.
const near = function () {
  return 'near';
};
tag('near', near);
Object.setPrototypeOf(near, ground);
const far = () => 'far';
tag('far', far);
Object.setPrototypeOf(far, relay);
const farther = function farther() {
  return 'farther';
};
tag('farther', farther);
Object.setPrototypeOf(farther, second);
const mixed = function () {
  return 'mixed';
};
tag('mixed', mixed);
const between = {};
Object.setPrototypeOf(between, second);
Object.setPrototypeOf(mixed, between);

near.constructor = 1;
far.constructor = 2;
farther.constructor = 3;
mixed.constructor = 4;
relay.constructor = 5;
console.log(heard.join('; '));
console.log(named(far), '|', named(farther), '|', named(mixed));
console.log([near, far, farther, mixed, relay, second].map((fn) => Object.hasOwn(fn, 'constructor')).join(' '));
console.log(near(), far(), farther(), mixed());

// The same walk for a name functions do not inherit.
heard.length = 0;
far.gain = 6;
farther.gain = 7;
console.log(heard.join('; '), Object.hasOwn(far, 'gain'), Object.hasOwn(farther, 'gain'));

// A data property met before the accessor shadows it: the write is the
// function's own, and the setter does not run.
heard.length = 0;
const shade = { constructor: 'shade' };
Object.setPrototypeOf(shade, second);
const shaded = () => 'shaded';
tag('shaded', shaded);
Object.setPrototypeOf(shaded, shade);
shaded.constructor = 8;
console.log(heard.length, named(shaded), Object.hasOwn(shaded, 'constructor'), shade.constructor);

// A function that already has the name as its own keeps writing its own
// after it gets such a chain.
const early = () => 'early';
tag('early', early);
early.constructor = 'first';
Object.setPrototypeOf(early, second);
early.constructor = 'again';
console.log(heard.length, named(early), Object.hasOwn(early, 'constructor'));

// What the setter throws reaches the assignment, and the setter ran once.
let calls = 0;
const strict = {
  set constructor(value) {
    calls++;
    if (typeof value !== 'number') throw new RangeError(`${labelOf(this)} wants a number`);
    heard.push(`${labelOf(this)} keeps ${value}`);
  },
};
function gate() {}
Object.setPrototypeOf(gate, strict);
const picky = () => 'picky';
tag('picky', picky);
Object.setPrototypeOf(picky, gate);
try {
  picky.constructor = 'text';
} catch (error) {
  console.log(error.name, error.message);
}
picky.constructor = 9;
console.log(calls, heard.join('; '), Object.hasOwn(picky, 'constructor'));
