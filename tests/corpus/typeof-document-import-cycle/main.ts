// A module-level import cycle whose value test is a `typeof` in an untyped
// dependency. The `typeof` folds the declared type of `document` and prints
// "object" before `document` is ever assigned.
import { label } from "./lib.js";

console.log(label());
