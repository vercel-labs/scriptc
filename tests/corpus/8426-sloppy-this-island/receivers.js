function isGlobal() {
  return this === globalThis;
}

function plain() {
  return this === globalThis ? "global" : "other";
}

// An explicit receiver is that receiver, never the global object.
function viaCall() {
  return isGlobal.call({ label: "receiver" });
}

function viaApply() {
  return isGlobal.apply({ label: "receiver" }, []);
}

// A bound undefined receiver is still the global object in sloppy mode.
function bound() {
  return isGlobal.bind(undefined)();
}

// An arrow has no `this` of its own: it sees the sloppy function's.
function arrow() {
  var see = () => this;
  return see() === globalThis;
}

module.exports = { isGlobal, plain, viaCall, viaApply, bound, arrow };
