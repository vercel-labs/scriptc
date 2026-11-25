// @requires-libnode
// An island package whose modules import each other by relative paths (the
// island's load plan answers those resolutions): an `export let` changed
// after import is seen through every re-export, as under Node.
import label, { bump, count, mode, reset, seen, setMode, twice } from "livepkg";

console.log("start", count, mode, label());
bump();
console.log("bumped", count, seen());
console.log("twice", twice(), count);
setMode("busy");
console.log("mode", mode, seen(), label());
reset();
console.log("reset", count, bump(), count, label());
