// Every String.prototype method begins with ToString(this), so a Symbol
// `this` throws Node's TypeError before the method looks at its arguments.
// Test262's built-ins/String/prototype/*-return-abrupt-from-this-as-symbol
// call the method objects this way; the arguments are still evaluated
// first, and a String receiver keeps working.
let s = Symbol('x');

function attempt(label, fn) {
  try {
    console.log(label, JSON.stringify(fn()));
  } catch (e) {
    console.log(label, e.name + ': ' + e.message);
  }
}

attempt('codePointAt', () => String.prototype.codePointAt.call(s, 1));
attempt('endsWith', () => String.prototype.endsWith.call(s, ''));
attempt('includes', () => String.prototype.includes.call(s, ''));
attempt('normalize', () => String.prototype.normalize.call(s));
attempt('repeat', () => String.prototype.repeat.call(s, 1));
attempt('startsWith', () => String.prototype.startsWith.call(s, ''));
attempt('padStart', () => String.prototype.padStart.call(s, 3));
attempt('toUpperCase', () => String.prototype.toUpperCase.call(s));
attempt('slice', () => String.prototype.slice.call(s, 0));
attempt('arguments-first', () =>
  String.prototype.startsWith.call(s, console.log('argument evaluated')));
attempt('string-receiver', () => String.prototype.startsWith.call('text', 'te'));
