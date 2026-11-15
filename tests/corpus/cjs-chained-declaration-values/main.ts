// A module-scope binding declared and attached to a member in one statement
// (`var table = exports.table = []`) holds the value the chain assigns. The
// functions of the module read it by the binding, also where the module's
// exports object is one of its own functions.
import gauge from "gauge-kit";
import { add, count, names, total } from "tally-kit";

console.log(gauge.check("1.2"), gauge.check("x"), gauge.check("v3.4", true));
console.log(gauge.check("v3.4"), gauge.parse("5.6")?.raw, gauge.parse("five") === null);
console.log(gauge.patterns.length, gauge.sources.length, gauge.labels.length);
console.log(gauge.label(0), gauge.label(1), gauge.sources[1]);

add("first", 2);
add("second", 3);
console.log(total(), count(), names().join(","));
