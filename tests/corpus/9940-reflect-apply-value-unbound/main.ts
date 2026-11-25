// A natively compiled CommonJS package exports Reflect.apply as a value from
// one module and calls it through the binding in another, with the builtin
// Function.prototype.bind as the target and Function.prototype.call as the
// receiver: the "unbound method" helper of ES5-style packages.
import { report } from "pour-kit";

for (const line of report()) console.log(line);
