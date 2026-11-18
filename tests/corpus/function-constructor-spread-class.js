// @disallow-code-generation
// `new (f.constructor)(...args)` constructs the class a function's own
// `constructor` property names, through the same dispatch as a class value
// the source always names. A callable return type hides that write, so only
// the value at run time decides what the member holds.
class Box {
  constructor(value, label) {
    this.value = value;
    this.label = label;
  }
}

class SubBox extends Box {
  constructor(value) {
    super(value, "sub");
  }
}

/** @returns {() => number} */
function makeBox() {
  const made = () => 1;
  made.constructor = Box;
  return made;
}

/** @returns {() => number} */
function makeSubBox() {
  const made = () => 1;
  made.constructor = SubBox;
  return made;
}

// A runtime-length spread, so the argument list is built before the
// construction check runs.
const parts = [2, "two"];
const box = new (makeBox().constructor)(...parts);
console.log(box.value, box.label, box instanceof Box);

// A derived class constructs through its own constructor.
const sub = new (makeSubBox().constructor)(...[3]);
console.log(sub.value, sub.label, sub instanceof SubBox, sub instanceof Box);

// The receiver is read first, then the arguments, in source order.
const order = [];
/** @returns {() => number} */
function receiver() {
  order.push("receiver");
  return makeBox();
}
function pack(tag, values) {
  order.push(tag);
  return values;
}
const ordered = new (receiver().constructor)(...pack("first", [1]), ...pack("second", ["second"]));
console.log(ordered.value, ordered.label, order.join(","));

// A nullish receiver throws the property-read TypeError before any argument
// runs.
/** @type {(() => number) | undefined} */
const absent = undefined;
const skipped = [];
function never(tag) {
  skipped.push(tag);
  return [];
}
try {
  new (absent.constructor)(...never("never"));
} catch (error) {
  console.log(error.name + ": " + error.message);
}
console.log(skipped.join(",") || "(none)");

// The inherited Function constructor refuses a spread construction as it
// refuses a call.
const expression = function () {
  return 1;
};
try {
  new (expression.constructor)(...["return 1"]);
} catch (error) {
  console.log(error.name + ": " + error.message);
}
