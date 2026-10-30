// A module namespace object stored as an untyped value, here in a registry
// keyed by module name (pi-coding-agent's VIRTUAL_MODULES): reads see the
// exports' current values, both registry entries are the same object, and
// writes throw Node's TypeError.
import { addThrough, bumpThrough, describe, same, writeThrough } from "ns-registry";

console.log(describe());
bumpThrough();
bumpThrough();
console.log(describe());
console.log(same(), writeThrough(), addThrough());
