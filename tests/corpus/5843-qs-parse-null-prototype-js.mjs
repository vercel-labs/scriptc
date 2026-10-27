// querystring.parse results keep their null prototype when they cross into
// checked-dynamic values in a JavaScript module: inspection, getPrototypeOf,
// ToPrimitive and the `in` operator.
import qs from "node:querystring";
const parsed = qs.parse("a=1&b=2&b=3");
const holder = { parsed, list: [parsed] };
console.log(holder);
const dyn = JSON.parse("{}");
dyn.p = parsed;
console.log(dyn, Object.getPrototypeOf(dyn.p) === null);
try { console.log(String(dyn.p)); } catch (e) { console.log(e.name, e.message); }
console.log("toString" in parsed, "a" in parsed);
