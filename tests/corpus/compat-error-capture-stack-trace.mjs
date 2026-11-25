// Error.captureStackTrace's targets: an Error instance and a function value.
// The stack a target answers is a heading and frames, the heading being the
// function's own name for a function target; writing `stack` replaces it.
// Frames below the program's own functions are the documented divergence, so
// only the heading and the presence of a frame are asked about — and each
// capture runs inside a function, where the frame is one of the program's.
function summary(target) {
  return [JSON.stringify(target.stack.split("\n")[0]), target.stack.includes("\n    at ")].join(" ");
}

function captureError() {
  const error = new Error("message");
  Error.captureStackTrace(error);
  return summary(error);
}

function named() {}
function captureNamed() {
  Error.captureStackTrace(named);
  return summary(named);
}

const arrow = () => {};
function captureArrow() {
  Error.captureStackTrace(arrow);
  return summary(arrow);
}

function counted() {}
function captureAndReplace() {
  Error.captureStackTrace(counted);
  const captured = typeof counted.stack;
  counted.stack = "replaced";
  return [captured, JSON.stringify(counted.stack)].join(" ");
}

// constructorOpt leaves out the frames from the named function upward; the
// captured function's own name stays the heading.
function captureFrom() {
  const holder = function holder() {};
  Error.captureStackTrace(holder, captureFrom);
  return [holder.stack.split("\n")[0], holder.stack.includes("at captureFrom")].join(" | ");
}

console.log("error", captureError());
console.log("function", captureNamed());
console.log("arrow", captureArrow());
console.log("captured", captureAndReplace());
console.log("from call site", captureFrom());
