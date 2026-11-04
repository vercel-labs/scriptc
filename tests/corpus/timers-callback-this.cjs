'use strict';
// A timer callback runs with `this` bound to its Timeout or Immediate, as
// Node calls it: a plain function and a function value that forwards
// `this` (test/common's mustCall wrapper) see the handle the call returned,
// also with trailing arguments, for a setTimeout called as a statement, and
// for a callback whose signature the timer adapts.
// clearInterval(this) stops an interval from inside it, and the clear
// functions accept the handle a callback reads as its own `this`. Arrows,
// also through a const binding, keep the module's `this`, and a nested
// plain call sees undefined.
function forwarding(fn) {
  return function (...args) {
    return fn.apply(this, args);
  };
}

const seen = [];
const immediate = setImmediate(function () {
  seen.push(['immediate', this === immediate]);
});
const immediateArgs = setImmediate(forwarding(function (word) {
  seen.push(['immediate args', this === immediateArgs, word]);
}), 'hello');
const timeout = setTimeout(forwarding(function () {
  seen.push(['timeout', this === timeout]);
}), 1);
let statementThis;
setTimeout(function () {
  statementThis = this !== undefined;
});
let ticks = 0;
const interval = setInterval(function () {
  ticks++;
  if (ticks === 2) clearInterval(this);
  seen.push(['interval', this === interval, ticks]);
}, 1);
const clearedImmediate = setImmediate(function () {
  clearImmediate(this);
  seen.push(['clearImmediate', this === clearedImmediate]);
});
const clearedTimeout = setTimeout(function () {
  clearTimeout(this);
  seen.push(['clearTimeout', this === clearedTimeout]);
}, 1);
setTimeout(() => {
  seen.push(['arrow', this === module.exports]);
}, 2);
// A const binding of an arrow is still an arrow: it keeps the module's
// `this`, and a plain call inside it has no receiver of its own.
const storedArrow = () => {
  function inner() {
    return this;
  }
  seen.push(['stored arrow', this === module.exports, inner() === undefined]);
};
setTimeout(storedArrow, 2);
// A const binding of a function that reads `this` is bound like the function.
const storedFunction = function () {
  seen.push(['stored function', this === storedFunctionHandle]);
};
const storedFunctionHandle = setTimeout(storedFunction, 1);
function plain() {
  return this;
}
setTimeout(function () {
  seen.push(['nested plain call', plain() === undefined]);
}, 3);
// The adapted signatures — a return value to drop, an argument to supply,
// a default parameter to run — with the wrapper forwarding the receiver.
function returnsValue() {
  seen.push(['returning declaration', this === returningDeclaration]);
  return 3;
}
const returningDeclaration = setTimeout(returnsValue, 1);
const returningExpression = setTimeout(function () {
  seen.push(['returning expression', this === returningExpression]);
  return true;
}, 1);
const asyncCallback = setTimeout(async function () {
  seen.push(['async', this === asyncCallback]);
}, 1);
const oneParameter = setTimeout(function (x) {
  seen.push(['one parameter', this === oneParameter, x === undefined]);
}, 1);
const defaultParameter = setTimeout(function (x = this) {
  seen.push(['default parameter', x === defaultParameter]);
}, 1);
const defaultParameterImmediate = setImmediate(function (x = this) {
  seen.push(['immediate default parameter', x === defaultParameterImmediate]);
});

setTimeout(() => {
  // Sorted, so the order the timers fire in does not decide the output.
  for (const entry of seen.map((e) => e.join(' ')).sort()) console.log(entry);
  console.log('statement setTimeout has this', statementThis, 'ticks', ticks);
}, 30);
