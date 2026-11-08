// A package's JavaScript function compiled for a string argument:
// `lastIndexOf` on the strings it derives, whose checker type is `any`.
// The search value converts with ToString, and an omitted one searches
// for "undefined".
import { lastOf, lastUndefined, relation } from "stripkit";

console.log(relation('Owner "1" > x'), relation("Plain > y"), relation('"a" "b" > z'), relation("none"));
console.log(lastOf(" a1b1c ", 1), lastOf("abc", "z"), lastOf("a,null,null", null), lastOf("abab", ""));
console.log(lastOf("true false true", true), lastOf("x undefined", undefined), lastUndefined(" undefined-undefined "));
