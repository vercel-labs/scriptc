// Date.prototype's Annex B accessors on checked-dynamic Dates: a JavaScript
// source's `d.getYear()` and `d.setYear(y)` reach the runtime's Date dispatch
// (scr_lib.c's SCR_DATE_ANNEXB build), and so do the same methods read off a
// Date as values. getYear is the local year less 1900; setYear maps 0-99 to
// 1900+y and keeps the other local fields. Node-exact.
var d = new Date(2020, 2, 5, 10, 30, 15, 250);

console.log("getYear:", d.getYear(), d.getYear() + 1900 === d.getFullYear());
console.log("invalid:", new Date(NaN).getYear());

var getYear = d.getYear;
console.log("method value:", getYear.call(d), getYear.call(new Date(1850, 0, 1)));

var setYear = d.setYear;
setYear.call(d, 71);
console.log("method value set:", d.getFullYear(), d.getMonth(), d.getDate());

var relative = new Date(1970, 0);
relative.setYear(-0.9999999);
console.log("relative -0.9999999:", relative.getFullYear());
relative = new Date(1970, 0);
relative.setYear(50.999999);
console.log("relative 50.999999:", relative.getFullYear());
relative = new Date(1970, 0);
relative.setYear(100);
console.log("absolute 100:", relative.getFullYear());

var nan = new Date(2020, 0, 1);
console.log("nan:", nan.setYear(NaN), Number.isNaN(nan.getTime()));

var invalid = new Date(NaN);
invalid.setYear(2020);
console.log("from invalid:", invalid.getFullYear(), invalid.getMonth(), invalid.getDate());

// The year argument converts before the time value is read: the argument's
// valueOf replaces the date's time value, and the setter keeps the fields of
// the replacement (B.2.3.2's steps 3-4 as V8 orders them).
var receiver = new Date(2020, 0, 1, 0, 0, 0);
var converted = false;
var argument = {
  valueOf: function () {
    receiver.setTime(new Date(2005, 5, 6).getTime());
    converted = true;
    return 42;
  },
};
var returned = receiver.setYear(argument);
console.log(
  "convert-before-read:",
  converted,
  receiver.getFullYear(),
  receiver.getMonth(),
  receiver.getDate(),
  returned === receiver.getTime(),
);

console.log("lengths:", Date.prototype.getYear.length, Date.prototype.setYear.length);
console.log("names:", Date.prototype.getYear.name, Date.prototype.setYear.name);
