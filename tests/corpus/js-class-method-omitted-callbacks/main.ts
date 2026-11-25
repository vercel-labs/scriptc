import * as helpers from "./helper.js";

// A class reached as a value hands out its methods through dynamic dispatch,
// so its parameters are whatever a JavaScript caller passes positionally.
const AnyHelpers = helpers as any;
const Loader = AnyHelpers.ResourceLoader;
console.log(new Loader().load("checker.png", (progress: number) => console.log("progress", progress)));
try {
  console.log(new Loader().load("checker.png"));
} catch (error) {
  console.log((error as Error).message);
}
// The same rule reaches a module function kept as a value, and a callback
// passed on to a builtin keeps Node's answer for the absent value.
try {
  AnyHelpers.eachStep([1, 2]);
} catch (error) {
  console.log((error as Error).message);
}
