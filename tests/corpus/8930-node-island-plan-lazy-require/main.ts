// @requires-libnode
// A require inside a function of an island package stays lazy: the module
// it names loads (and prints) at the first call, not when the package
// loads, and a branch that is not taken loads nothing.
import { again, heavy, light, maybe } from "lazypkg";

console.log("start", light());
console.log("before heavy");
console.log(heavy(), heavy());
console.log(maybe(false));
console.log("before optional");
console.log(maybe(true), again());
