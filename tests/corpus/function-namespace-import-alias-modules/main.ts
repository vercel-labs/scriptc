// @transform-types
// `import x = fn.member` where the function+namespace merge lives in
// another module: the alias copies the property when its statement runs,
// and keeps the copy when the exporting module replaces the property.
import { gauge, rescale } from "./gauge.ts";
import unit = gauge.unit;
import digits = gauge.digits;
import twice = gauge.twice;
console.log(unit, digits, twice(2), gauge(1), gauge.twice(2));
rescale("km");
console.log(unit, digits, twice(2), gauge(1), gauge.unit, gauge.digits, gauge.twice(2));
import unitNow = gauge.unit;
import twiceNow = gauge.twice;
console.log(unit, unitNow, twice(1), twiceNow(1));
