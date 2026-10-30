// The strict half of SC0007: Annex B's allowance for a plain function
// declaration in an if/else body or a labelled statement is non-strict code
// only, so a "use strict" prologue takes it away — Node agrees on both
// shapes. The sloppy fixture beside this one pins the refusals that hold in
// both modes.
"use strict";
if (true) function inIf() {}
l: function inLabel() {}
