// A require cycle whose partner reads a const export of index.js while
// index is still initializing: Node throws a ReferenceError (the binding
// is in its temporal dead zone), and scriptc refuses the cycle.
import { show } from "gtcyclebad";

console.log(show());
