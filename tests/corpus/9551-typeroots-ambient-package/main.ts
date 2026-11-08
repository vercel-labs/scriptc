// @requires-libnode
// A package that ships no declarations, typed by the project itself: an
// ambient module in a directory that the tsconfig lists under `typeRoots`
// and under `include`. The build cannot compile the namespace import of a
// CommonJS package natively: it decides a Node island for that package in a
// second round and loads the program again, and every load has to find the
// project's declarations.
import { scale } from "pantry-units";
import * as oven from "oven-dial";

const doubled = scale([120, 45, 2.5], 2);
console.log(doubled.join(" / "), oven.gasMark(180), oven.gasMark(250) <= oven.hottest);
