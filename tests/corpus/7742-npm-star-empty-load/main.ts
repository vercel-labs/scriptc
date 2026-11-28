// A star re-export of a module that exports nothing must still LOAD that
// module: its side effects run in order, exactly as Node's require does.
import { label } from "kit2";
console.log(label);
