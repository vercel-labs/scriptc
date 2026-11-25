// The ambient module passes on the declarations of a file that the
// package's `exports` map does not list. This project resolves as a
// bundler does: its own tsc reads the map, finds no such file, and reports
// every imported member as missing. Each load of the build does the same.
import { blend, titles, type Blend } from "spice-rack/blends";
import * as oven from "oven-dial";

const picked: Blend = blend(titles[0]);
console.log(titles.length, picked.parts, oven.gasMark(180));
