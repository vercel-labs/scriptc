console.log(JSON.stringify([
  "xy".padStart(),
  "xy".padEnd(),
  "xy".padStart(undefined, "_"),
  "xy".padEnd(null, "_"),
  "xy".padStart(4, undefined),
  "xy".padEnd(4, void 0),
  "xy".padStart(5, null),
  "xy".padEnd(5, false),
  "xy".padStart("5.9", true),
  "xy".padEnd("5.9", NaN),
  String.prototype.padStart.call(42, 5, "0"),
  String.prototype.padEnd.call(false, 8, "-"),
]));

let order = "";
function receiver() {
  order += "r";
  return {
    toString: function() { order += "T"; return {}; },
    valueOf: function() { order += "V"; return "xy"; },
  };
}
function length() {
  order += "l";
  return {
    valueOf: function() { order += "N"; return {}; },
    toString: function() { order += "S"; return "5.9"; },
  };
}
function fill() {
  order += "f";
  return {
    toString: function() { order += "F"; return {}; },
    valueOf: function() { order += "G"; return "_"; },
  };
}
console.log(String.prototype.padStart.call(receiver(), length(), fill()), order);

let fillCalls = 0;
const skippedFill = { toString: function() { fillCalls++; return "$"; } };
console.log("abc".padStart(2, skippedFill), "abc".padEnd(NaN, skippedFill), fillCalls);

let sideEffects = "";
function ignoredFill() { sideEffects += "f"; return "_"; }
console.log("abc".padEnd(2, ignoredFill()), sideEffects);

const dynamicFill = Math.floor(1.9) === 1 ? false : "_";
console.log("xy".padStart(6, dynamicFill), "xy".padEnd(6, dynamicFill));

let nullishOrder = "";
function badLength() { nullishOrder += "l"; return 2; }
function badFill() { nullishOrder += "f"; return "_"; }
try {
  String.prototype.padEnd.call(null, badLength(), badFill());
} catch (error) {
  console.log(nullishOrder, error.name, error.message);
}
