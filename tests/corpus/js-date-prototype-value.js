// Date.prototype read as a value in JavaScript: the prototype object the
// language defines, not a Date. The interface's existence tests
// (Sputnik's `Date.prototype.hasOwnProperty("getTime")`), the identity of
// the object across reads, its constructor link in both directions, and the
// TypeError a Date method throws when it is called on the prototype itself
// (the receiver has no [[DateValue]]).
'use strict';

const names = [
  "constructor",
  "toString",
  "toDateString",
  "toTimeString",
  "toISOString",
  "toUTCString",
  "toJSON",
  "toLocaleString",
  "toLocaleDateString",
  "toLocaleTimeString",
  "valueOf",
  "getTime",
  "getFullYear",
  "getUTCFullYear",
  "getMonth",
  "getUTCMonth",
  "getDate",
  "getUTCDate",
  "getDay",
  "getUTCDay",
  "getHours",
  "getUTCHours",
  "getMinutes",
  "getUTCMinutes",
  "getSeconds",
  "getUTCSeconds",
  "getMilliseconds",
  "getUTCMilliseconds",
  "getTimezoneOffset",
  "getYear",
  "setTime",
  "setMilliseconds",
  "setUTCMilliseconds",
  "setSeconds",
  "setUTCSeconds",
  "setMinutes",
  "setUTCMinutes",
  "setHours",
  "setUTCHours",
  "setDate",
  "setUTCDate",
  "setMonth",
  "setUTCMonth",
  "setFullYear",
  "setUTCFullYear",
  "setYear",
];

let own = 0;
for (const name of names) {
  if (Date.prototype.hasOwnProperty(name)) own++;
}
console.log("own", own, "of", names.length);

// A member the interface does not have, and an inherited one that is not
// on the prototype object: only Object.prototype's members are.
console.log("absent", Date.prototype.hasOwnProperty("nope"));
console.log("toStringTag", Date.prototype.hasOwnProperty("toStringTag"));

// One object per program, with the constructor link in both directions.
console.log("identity", Date.prototype === Date.prototype);
console.log("constructor", Date.prototype.constructor === Date);

// The methods are the same functions the member reads answer, and they are
// functions, not Dates.
console.log("getTimeType", typeof Date.prototype.getTime);
console.log("getTimeIdentity", Date.prototype.getTime === Date.prototype.getTime);
console.log("toISOStringType", typeof Date.prototype.toISOString);

// Annex B's toGMTString is toUTCString: one function, under both keys, so it
// carries that function's name.
console.log("toGMTStringAlias", Date.prototype.toGMTString === Date.prototype.toUTCString);
console.log("toGMTStringName", Date.prototype.toGMTString.name);

// The interface functions' `length`: the declared argument count, not the
// dispatch arity (setHours takes 4 arguments, setMonth 2, toJSON 1).
console.log(
  "lengths",
  Date.prototype.getTime.length,
  Date.prototype.toJSON.length,
  Date.prototype.setDate.length,
  Date.prototype.setMonth.length,
  Date.prototype.setHours.length,
);

// A Date method called on the prototype object itself: the receiver has no
// [[DateValue]], so Node throws TypeError.
function report(name, call) {
  try {
    call();
    console.log(name, "no-throw");
  } catch (error) {
    console.log(name, error instanceof TypeError, error instanceof Error);
  }
}
report("getTime", () => Date.prototype.getTime());
report("valueOf", () => Date.prototype.valueOf());
report("toISOString", () => Date.prototype.toISOString());
report("getFullYear", () => Date.prototype.getFullYear());

// The prototype is not a Date, and a real Date is unaffected.
console.log("instanceofDate", Date.prototype instanceof Date);
const date = new Date(0);
console.log("dateTime", date.getTime());
