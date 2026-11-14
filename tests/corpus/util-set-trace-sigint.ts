// util.setTraceSigInt toggles Node's --trace-sigint diagnostics hook. A
// compiled program has no such hook, and the call reads no argument and
// answers undefined; the argument expression is still evaluated.
import { setTraceSigInt } from "node:util";

let count = 0;
function tick(): boolean {
  count++;
  return false;
}
setTraceSigInt(true);
setTraceSigInt(tick());
console.log(count);
