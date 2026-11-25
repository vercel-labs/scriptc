// @requires-libnode
// A CommonJS package binds an island package's module with `var`, uses it
// while its module evaluates and writes the binding again there. A binding
// that is written is not the module at every use, so the package does not
// stay native: it runs in the island with the package it requires, and
// the program prints what Node prints.
import { label } from "shelf-swap";

console.log(label("salt"), label("rice"));
