// A Date instance's method read carries its ECMAScript `length` before
// Date.prototype has been built: `toJSON` takes the key JSON.stringify passes,
// a setter takes one to four fields, and a getter takes none.

const date = new Date(0);
console.log(
  "length",
  date.toJSON.length,
  date.getTime.length,
  date.setTime.length,
  date.setSeconds.length,
  date.setHours.length,
  date.setFullYear.length,
);
console.log("prototype", typeof Date.prototype.toJSON, Date.prototype.toJSON.length);
console.log("arguments", date.toJSON("key"), date.setTime(7), date.toJSON.length);
