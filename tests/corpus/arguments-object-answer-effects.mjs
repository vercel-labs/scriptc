// An answer about the arguments object replaces a call's value and not its
// evaluation: the call's other arguments are evaluated, in source order, the
// list `apply` is given is read, and a constant that holds the object is
// read, which throws before its declaration.

const steps = [];
function step(label, value) {
  steps.push(label);
  return value;
}
function stop() {
  throw new Error("stopped");
}
function report(run) {
  let answer;
  try {
    answer = String(run());
  } catch (e) {
    answer = "caught " + e.name + (e.name === "Error" ? ": " + e.message : "");
  }
  console.log(answer, steps.splice(0).join(","));
}

function tagOfMadeList() {
  return Object.prototype.toString.apply(arguments, step("list", []));
}
report(() => tagOfMadeList("oak", "elm"));

function tagOfStoppedList() {
  return Object.prototype.toString.apply(arguments, stop());
}
report(() => tagOfStoppedList("oak"));

function tagOfElements() {
  return Object.prototype.toString.apply(arguments, [step("first", 1), step("second", 2)]);
}
report(() => tagOfElements("oak"));

function tagWithExtras() {
  return Object.prototype.toString.call(arguments, step("first", 1), step("second", 2));
}
report(() => tagWithExtras("oak"));

function tagWithStoppedExtra() {
  return Object.prototype.toString.call(arguments, step("first", 1), stop(), step("never", 2));
}
report(() => tagWithStoppedExtra("oak"));

// `apply` reads its list: its length, and a list that is not an object is a
// TypeError.
const counted = {
  get length() {
    steps.push("length");
    return 0;
  },
};
function tagOfCountedList() {
  return Object.prototype.toString.apply(arguments, counted);
}
report(() => tagOfCountedList("oak"));

function tagOfNumberList() {
  return Object.prototype.toString.apply(arguments, 5);
}
report(() => tagOfNumberList("oak"));

function arrayTestWithExtras() {
  return Array.isArray(arguments, step("first", 1), step("second", 2));
}
report(() => arrayTestWithExtras("oak"));

// A constant that holds the object, asked before its declaration has run.
function askedEarly() {
  const ask = () =>
    [Array.isArray(held), held instanceof Array, Object.prototype.toString.call(held)].join(" ");
  report(ask);
  const held = arguments;
  return ask();
}
report(() => askedEarly("oak"));
