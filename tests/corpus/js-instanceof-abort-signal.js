// `instanceof AbortSignal`: Node's global is the constructor of the signals
// the runtime hands out, so a signal answers true and every other value —
// a controller, a plain object, null, undefined — answers false. The
// constructor itself throws Node's ERR_ILLEGAL_CONSTRUCTOR when `new` runs.
'use strict';

function hasSignal(options) {
  return options.signal instanceof AbortSignal;
}

var controller = new AbortController();
console.log(hasSignal({ signal: null }), hasSignal({ signal: controller.signal }));
console.log(hasSignal({ signal: controller }), hasSignal({ signal: {} }));
console.log(controller.signal instanceof AbortSignal);
console.log(AbortSignal.abort() instanceof AbortSignal);
console.log(AbortSignal.timeout(1) instanceof AbortSignal);
console.log(AbortSignal.any([controller.signal]) instanceof AbortSignal);
console.log(typeof AbortSignal, AbortSignal.name);

var held = controller.signal;
console.log(held instanceof AbortSignal, held instanceof Object);

var argumentRan = 0;
try {
  new AbortSignal(argumentRan++);
} catch (error) {
  console.log(error.name, error.code, error.message);
}
console.log("arguments evaluated:", argumentRan);
