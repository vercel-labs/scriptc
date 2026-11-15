// A module-level import cycle whose value test is a `typeof` in an untyped
// dependency, evaluated once the cycle's modules have run: it prints
// "object".
import { label } from "./lib.js";

console.log(label());
