// Date's Annex B accessors read through a property key computed at run time.
// The checked-dynamic member read looks the key up in the runtime's Date
// dispatch table, which lists getYear and setYear, so these calls answer the
// same way as the literal-name reads: the dispatch that serves them is the
// build the compiler selects for the computed read. Node-exact, and the
// printed fields are local, so the output does not depend on the host zone.
var d = new Date(2020, 2, 5, 10, 30, 15, 250);
var names = ["getYear", "setYear", "getFullYear"];

var getYearName = names[0];
console.log("computed read:", typeof d[getYearName], d[getYearName]());
console.log("computed read invalid:", new Date(NaN)[getYearName]());

var setYearName = names[1];
var returned = d[setYearName](71);
console.log(
  "computed setYear:",
  returned === d.getTime(),
  d.getFullYear(),
  d.getMonth(),
  d.getDate(),
);

// The prototype's member table lists both names, so the prototype answers a
// computed read too.
var prototypeName = names[0];
console.log(
  "prototype computed:",
  typeof Date.prototype[prototypeName],
  Date.prototype[prototypeName].name,
  Date.prototype[prototypeName].length,
);
console.log("prototype computed call:", Date.prototype[prototypeName].call(new Date(1850, 0, 1)));

// A computed key that names a non-Annex-B member keeps its ordinary answer.
var fullYearName = names[2];
console.log("computed getFullYear:", d[fullYearName](), d[fullYearName]() === d.getFullYear());
