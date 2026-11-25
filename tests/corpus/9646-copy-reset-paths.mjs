// A copy of a binding that a called function assigned (`var c = text`,
// which TypeScript types `undefined`) and an assignment of the copy's own
// on some or all paths to the read. The read is `undefined` only where
// every path that reaches it stored `undefined` last; on every other path
// it is the value the copy holds. Each shape runs both ways.

function Holder() {}
Holder.prototype.show = function (value) {
  return typeof value + " " + String(value);
};
const holder = new Holder();
function result(c, n) {
  return holder.show(c) + " / " + "abcd".slice(n);
}

function conditionalThenReset(assign) {
  var text, size;
  function fill() {
    text = "filled";
    size = 2;
  }
  fill();
  var c, n;
  if (assign) {
    c = text;
    n = size;
  }
  c = undefined;
  n = undefined;
  return holder.show(c) + " / " + "abcd".slice(n);
}

function bothArms(first) {
  var text, size;
  function fill() {
    text = "filled";
    size = 2;
  }
  fill();
  var c = text;
  var n = size;
  if (first) {
    c = undefined;
    n = undefined;
  } else {
    n = undefined;
    c = undefined;
  }
  return holder.show(c) + " / " + "abcd".slice(n);
}

function oneArm(reset) {
  var text, size;
  function fill() {
    text = "filled";
    size = 2;
  }
  fill();
  var c = text;
  var n = size;
  if (reset) {
    c = undefined;
    n = undefined;
  }
  return holder.show(c) + " / " + "abcd".slice(n);
}

function shortCircuit(form, flag) {
  var text, size;
  function fill() {
    text = "filled";
    size = 2;
  }
  fill();
  var c = text;
  var n = size;
  var call = flag ? function () {} : undefined;
  if (form === "&&") {
    flag && (c = undefined);
    flag && (n = undefined);
  } else if (form === "||") {
    flag || (c = undefined);
    flag || (n = undefined);
  } else if (form === "??") {
    (flag ? null : 0) ?? (c = undefined);
    (flag ? null : 0) ?? (n = undefined);
  } else if (form === "?:") {
    flag ? (c = undefined) : 0;
    flag ? 0 : (n = undefined);
  } else {
    call?.((c = undefined), (n = undefined));
  }
  return holder.show(c) + " / " + "abcd".slice(n);
}

function earlyExit(stop) {
  var text, size;
  function fill() {
    text = "filled";
    size = 2;
  }
  fill();
  var c = text;
  var n = size;
  for (var i = 0; i < 1; i++) {
    if (stop) break;
    c = undefined;
    n = undefined;
  }
  return holder.show(c) + " / " + "abcd".slice(n);
}

function afterReturn(stop) {
  var text, size;
  function fill() {
    text = "filled";
    size = 2;
  }
  fill();
  var c = text;
  var n = size;
  if (stop) return holder.show(c) + " / " + "abcd".slice(n);
  c = undefined;
  n = undefined;
  return holder.show(c) + " / " + "abcd".slice(n);
}

function afterThrow(fail) {
  var text, size;
  function fill() {
    text = "filled";
    size = 2;
  }
  fill();
  var c = text;
  var n = size;
  var inside;
  try {
    if (fail) throw new Error("stop");
    c = undefined;
    n = undefined;
    inside = holder.show(c) + " / " + "abcd".slice(n);
  } catch (e) {
    inside = "caught " + holder.show(c) + " / " + "abcd".slice(n);
  }
  return inside + " then " + holder.show(c) + " / " + "abcd".slice(n);
}

function loopBody(times) {
  var text, size;
  function fill() {
    text = "filled";
    size = 2;
  }
  fill();
  var c = text;
  var n = size;
  var seen = [];
  for (var i = 0; i < times; i++) {
    c = undefined;
    n = undefined;
    seen.push(holder.show(c) + " " + "abcd".slice(n));
    c = text;
    n = size;
  }
  return seen.join(", ") + " then " + holder.show(c) + " / " + "abcd".slice(n);
}

function declaredInLoop(times) {
  var text, size;
  function fill() {
    text = "filled";
    size = 2;
  }
  fill();
  var seen = [];
  for (var i = 0; i < times; i++) {
    var c;
    var n;
    let fresh;
    let freshSize;
    seen.push(holder.show(c) + " " + "abcd".slice(n) + " " + holder.show(fresh) + " " + "abcd".slice(freshSize));
    c = text;
    n = size;
    fresh = text;
    freshSize = size;
  }
  return seen.join(", ");
}

function inTry(fail) {
  var text, size;
  function fill() {
    text = "filled";
    size = 2;
  }
  fill();
  var c = text;
  var n = size;
  try {
    if (fail) throw new Error("stop");
    c = undefined;
    n = undefined;
  } catch (e) {}
  return holder.show(c) + " / " + "abcd".slice(n);
}

function inCatch(fail) {
  var text, size;
  function fill() {
    text = "filled";
    size = 2;
  }
  fill();
  var c = text;
  var n = size;
  try {
    if (fail) throw new Error("stop");
  } catch (e) {
    c = undefined;
    n = undefined;
  }
  return holder.show(c) + " / " + "abcd".slice(n);
}

function inFinally(fail) {
  var text, size;
  function fill() {
    text = "filled";
    size = 2;
  }
  fill();
  var c = text;
  var n = size;
  try {
    try {
      if (fail) throw new Error("stop");
    } finally {
      c = undefined;
      n = undefined;
    }
  } catch (e) {}
  return holder.show(c) + " / " + "abcd".slice(n);
}

function inSwitch(key) {
  var text, size;
  function fill() {
    text = "filled";
    size = 2;
  }
  fill();
  var c = text;
  var n = size;
  switch (key) {
    case 1:
      c = undefined;
    case 2:
      n = undefined;
      break;
    default:
  }
  return holder.show(c) + " / " + "abcd".slice(n);
}

function labeled(leave) {
  var text, size;
  function fill() {
    text = "filled";
    size = 2;
  }
  fill();
  var c = text;
  var n = size;
  block: {
    if (leave) break block;
    c = undefined;
    n = undefined;
  }
  return holder.show(c) + " / " + "abcd".slice(n);
}

function byClosure(call) {
  var text, size;
  function fill() {
    text = "filled";
    size = 2;
  }
  fill();
  var c = text;
  var n = size;
  function clear() {
    c = undefined;
    n = undefined;
  }
  if (call) clear();
  return holder.show(c) + " / " + "abcd".slice(n);
}

function destructured(reset) {
  var text, size;
  function fill() {
    text = "filled";
    size = 2;
  }
  fill();
  var c = text;
  var n = size;
  var none = [undefined, undefined];
  var pair = { c: text, n: size };
  if (reset) [c, n] = none;
  var first = holder.show(c) + " / " + "abcd".slice(n);
  c = undefined;
  n = undefined;
  ({ c, n } = pair);
  return first + " then " + holder.show(c) + " / " + "abcd".slice(n);
}

function otherValues(kind) {
  var text, size;
  function fill() {
    text = "filled";
    size = 2;
  }
  fill();
  var c = text;
  var n = size;
  if (kind === "null") {
    c = null;
    n = null;
  } else if (kind === "other") {
    c = 7;
    n = "1";
  } else {
    c = undefined;
    n = undefined;
    c = text;
    n = size;
  }
  return holder.show(c) + " / " + "abcd".slice(n);
}

function same(value) {
  return value;
}
function throughItself(form, flag) {
  var text, size;
  function fill() {
    text = "filled";
    size = 2;
  }
  if (form !== "??" || flag) fill();
  var c = text;
  var n = size;
  var otherText = "other";
  var otherSize = 1;
  if (form === "?:") {
    c = flag ? c : undefined;
    n = flag ? n : undefined;
  } else if (form === "??") {
    c = c ?? otherText;
    n = n ?? otherSize;
  } else if (form === "||=") {
    c ||= otherText;
    n ||= otherSize;
  } else if (form === "call") {
    c = same(c);
    n = flag ? same(n) : same(undefined);
  } else if (form === "self") {
    c = c;
    n = flag && n;
  } else {
    var held = c;
    c = n;
    n = held;
  }
  return holder.show(c) + " / " + "abcd".slice(n);
}

function returned(reset) {
  var text;
  function fill() {
    text = "filled";
  }
  fill();
  var c = text;
  if (reset) c = undefined;
  return c;
}
function returnedAfterReset() {
  var text;
  function fill() {
    text = "filled";
  }
  fill();
  var c = text;
  c = undefined;
  return c;
}

console.log("conditional, then a reset:", conditionalThenReset(true), "|", conditionalThenReset(false));
console.log("reset in both arms:", bothArms(true), "|", bothArms(false));
console.log("reset in one arm:", oneArm(true), "|", oneArm(false));
for (const form of ["&&", "||", "??", "?:", "?.()"]) {
  console.log("reset under " + form + ":", shortCircuit(form, true), "|", shortCircuit(form, false));
}
console.log("reset after an early exit:", earlyExit(true), "|", earlyExit(false));
console.log("reset after an early return:", afterReturn(true), "|", afterReturn(false));
console.log("reset after a throw:", afterThrow(true), "|", afterThrow(false));
console.log("reset in a loop body:", loopBody(0), "|", loopBody(2));
console.log("declared in a loop body:", declaredInLoop(1), "|", declaredInLoop(3));
console.log("reset in try:", inTry(true), "|", inTry(false));
console.log("reset in catch:", inCatch(true), "|", inCatch(false));
console.log("reset in finally:", inFinally(true), "|", inFinally(false));
console.log("reset in a switch:", inSwitch(1), "|", inSwitch(2), "|", inSwitch(3));
console.log("reset in a labeled block:", labeled(true), "|", labeled(false));
console.log("reset by a closure:", byClosure(true), "|", byClosure(false));
console.log("destructuring:", destructured(true), "|", destructured(false));
console.log("null, another value, the read again:", otherValues("null"), "|", otherValues("other"), "|", otherValues("again"));
for (const form of ["?:", "??", "||=", "call", "self", "swap"]) {
  console.log("assigned from itself, " + form + ":", throughItself(form, true), "|", throughItself(form, false));
}
console.log("returned:", result(returned(true), 1), "|", result(returned(false), 1), "|", result(returnedAfterReset(), 1));
