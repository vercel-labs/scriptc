// @requires-libnode
// A package scriptc compiles natively only with runtime fences that need
// a mutable object model (getters over live bindings, a constructor
// function with prototype methods) runs in a Node island automatically.
import { bump, current, Tally } from "fencedkit";
import kit from "fencedkit";

console.log(current, bump(), bump(), kit.current);
const t = new Tally(1);
console.log(t.add(2) === t, t.add(3).total, t instanceof Tally);
