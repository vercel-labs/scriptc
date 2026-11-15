// A feature test that reads a built-in member through the prototype of a
// value made for it (`Object.getPrototypeOf([f()]).at`) has one answer, and
// making the value still runs: the test is evaluated, and the polyfill it
// guards is not lowered. The prototype of a literal that runs nothing
// (`Object.getPrototypeOf([])`) decides the test with nothing to evaluate.
let calls = 0;
function note(label: string): number {
  calls++;
  console.log("note", label);
  return calls;
}

if (!Object.getPrototypeOf([note("member")]).at) {
  Array.prototype.at = function () {
    return undefined;
  };
}
console.log("member", calls);

if (typeof Object.getPrototypeOf([note("typeof")]).at !== "function") {
  Array.prototype.at = function () {
    return undefined;
  };
}
console.log("typeof", calls);

if (!("at" in Object.getPrototypeOf([note("in")]))) {
  Array.prototype.at = function () {
    return undefined;
  };
}
console.log("in", calls);

if (!Object.getPrototypeOf([note("own")]).hasOwnProperty("at")) {
  Array.prototype.at = function () {
    return undefined;
  };
}
console.log("own", calls);

if (Object.getPrototypeOf({ k: note("object") }).toString === undefined) {
  Object.prototype.toString = function () {
    return "replaced";
  };
}
console.log("object", calls);

Object.getPrototypeOf([note("or-assign")]).at ||= function () {
  return undefined;
};
console.log("or-assign", calls);

Object.getPrototypeOf([note("keep-target")]).at =
  Object.getPrototypeOf([note("keep-read")]).at ||
  function () {
    return undefined;
  };
console.log("keep", calls);

// A guard that always leaves: its test is evaluated where the `if` is, and
// the polyfill behind it is not lowered.
function install(): void {
  if (Object.getPrototypeOf([note("early")]).indexOf) return;
  Array.prototype.indexOf = function () {
    return -1;
  };
}
install();
console.log("early", calls, [1, 2].indexOf(2));

let ran = 0;
if (
  !Object.getPrototypeOf([]).at ||
  !Object.getPrototypeOf([1, "a", [2], { k: 1 }]).map ||
  !Object.getPrototypeOf({}).toString ||
  !Object.getPrototypeOf(function () {}).call ||
  !Object.getPrototypeOf(/x/).exec
) {
  ran++;
  Array.prototype.at = function () {
    return undefined;
  };
}
Object.getPrototypeOf([]).at ||
  (Array.prototype.at = function () {
    return undefined;
  });

console.log(calls, ran, [1, 2, 3].at(-1), String({}));
