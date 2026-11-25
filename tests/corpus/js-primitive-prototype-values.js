// Number.prototype and Boolean.prototype are objects in JavaScript: the
// wrappers around +0 and false, carrying their methods as non-enumerable
// data properties. Reading one used to answer undefined.
console.log(typeof Number.prototype, typeof Boolean.prototype);
console.log(Number.prototype === Number.prototype, Boolean.prototype === Boolean.prototype);
console.log(Number.prototype.toString(), Number.prototype.toString(2), Number.prototype.toFixed(2));
console.log(Number.prototype.valueOf(), Boolean.prototype.valueOf(), Boolean.prototype.toString());
console.log(Object.getPrototypeOf(Number.prototype) === Object.prototype);
console.log(Object.getPrototypeOf(Boolean.prototype) === Object.prototype);
console.log(Number.prototype.hasOwnProperty('toString'), Number.prototype.hasOwnProperty('nope'));
console.log(Object.keys(Number.prototype).length, Object.keys(Boolean.prototype).length);
console.log(typeof Number.prototype.toString, Number.prototype.toString.name, Number.prototype.toString.length);
console.log(Boolean.prototype.valueOf.name, Boolean.prototype.toString.name, Boolean.prototype.toString.length);

// The methods are not generic: only a primitive of the kind, or the
// prototype object itself (the wrapper around +0 / false), is a `this`.
const attempt = (label, run) => {
  try {
    console.log(label, 'no-throw', JSON.stringify(run()));
  } catch (error) {
    console.log(label, error.constructor.name, error.message);
  }
};
attempt('num-null', () => Number.prototype.toString.call(null));
attempt('num-object', () => Number.prototype.toString.call({}));
attempt('num-string', () => Number.prototype.valueOf.call('5'));
attempt('num-bool', () => Number.prototype.toFixed.call(true));
attempt('num-number', () => Number.prototype.toString.call(255, 16));
attempt('bool-object', () => Boolean.prototype.valueOf.call({}));
attempt('bool-number', () => Boolean.prototype.toString.call(1));
attempt('bool-boolean', () => Boolean.prototype.valueOf.call(true));
const holder = new Object();
holder.toString = Number.prototype.toString;
attempt('holder', () => holder.toString());
const other = new Object();
other.myValueOf = Number.prototype.valueOf;
attempt('holder-valueOf', () => other.myValueOf());
