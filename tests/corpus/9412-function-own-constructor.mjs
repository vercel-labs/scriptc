// `constructor` is an ordinary property name on a function: a library
// replaces it on the function it hands out, here to refuse a deprecated
// call. The function keeps working, and every other function keeps the
// inherited value.
function make(label) {
  const made = (...parts) => label + parts.join(' ');
  made.constructor = () => {
    throw new Error('`' + label + 'constructor()` is deprecated');
  };
  return made;
}

const first = make('first ');
const second = make('second ');
console.log(first('a', 'b'), second('c'), typeof first.constructor, first.constructor === Function);
try {
  first.constructor();
} catch (error) {
  console.log(error.message);
}
console.log(
  Object.getOwnPropertyNames(first).includes('constructor'),
  Object.keys(first).join(','),
  first.constructor === second.constructor,
);

function plain() {}
console.log(plain.constructor === Function, Object.getOwnPropertyNames(plain).includes('constructor'));

// A data value, and a later replacement.
const tagged = () => 'tagged';
tagged.constructor = 'label';
console.log(tagged.constructor, tagged());
tagged.constructor = 7;
console.log(tagged.constructor + 1, tagged());

// An object's own `constructor` is the ordinary write it always was.
const holder = {};
holder.constructor = 'mine';
console.log(holder.constructor, Object.keys(holder).join(','));
