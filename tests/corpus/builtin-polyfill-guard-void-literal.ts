// A polyfill guard that compares a built-in member with `void 0`, the
// spelling of undefined: the operand is a literal, so the test has one
// answer and nothing to run, and neither it nor the polyfill is lowered.
let ran = 0;

if (Array.prototype.at === void 0) {
  ran++;
  Array.prototype.at = function () {
    return undefined;
  };
}

if (void 0 !== Array.prototype.at) {
  console.log("present");
} else {
  ran++;
  Array.prototype.at = function () {
    return undefined;
  };
}

if (Array.prototype.includes == void "unused") {
  ran++;
  Array.prototype.includes = function () {
    return false;
  };
}

Array.prototype.at !== void 0 ||
  (Array.prototype.at = function () {
    return undefined;
  });

Array.prototype.at === void 0 &&
  (Array.prototype.at = function () {
    return undefined;
  });

console.log(ran, [1, 2, 3].at(-1), [1, 2, 3].includes(2));
