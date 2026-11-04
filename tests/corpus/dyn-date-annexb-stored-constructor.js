// A Date built through a constructor value stored in a variable reads the
// Annex B accessors through a computed key, and so does one built through
// the global object. Node-exact, and the printed fields are local, so the
// output does not depend on the host zone.
var Ctor = Date;
var d = new Ctor(2020, 2, 5, 10, 30, 15, 250);
var names = ["getYear", "setYear"];

var getYearName = names[0];
console.log("stored constructor read:", typeof d[getYearName], d[getYearName]());

var setYearName = names[1];
var returned = d[setYearName](71);
console.log("stored constructor setYear:", returned === d.getTime(), d.getFullYear());

var GlobalDate = globalThis.Date;
var e = new GlobalDate(1999, 11, 31);
console.log(
  "global constructor read:",
  typeof e[getYearName],
  e[getYearName](),
  e[setYearName](84) === e.getTime(),
  e.getFullYear(),
);
