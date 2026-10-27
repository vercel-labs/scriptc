// Date.prototype.setTime on Dates a JavaScript file constructs: the Date
// is one mutable object, so every reference sees the new time value.
function shifted(year, month, day, minutes) {
  const date = new Date(Date.UTC(year, month, day, 12, 30, 15, 250));
  if (minutes) date.setTime(date.getTime() - minutes * 60000);
  return date;
}
const unchanged = shifted(2001, 1, 3, 0);
const moved = shifted(2001, 1, 3, 90);
console.log(unchanged.toISOString(), moved.toISOString());

const alias = moved;
const record = { when: moved };
console.log(moved.setTime(1000), alias.getTime(), record.when.toISOString());
console.log(moved.setTime("2500"), moved.getTime(), moved.setTime(1.9), moved.setTime(-1.9));
console.log(moved.setTime(NaN), moved.getTime(), String(moved), moved.toJSON());
console.log(moved.setTime(8.64e15), moved.setTime(8.64e15 + 1), moved.setTime(-8.64e15 - 1));
console.log(Object.is(moved.setTime(-0), 0), moved.setTime(), moved.setTime(true), moved.setTime(null));
console.log(moved.setTime({ valueOf: () => 86400000 }), moved.toISOString());
try {
  moved.setTime({ valueOf: () => { throw new Error("no time"); } });
} catch (error) {
  console.log(error.message, moved.toISOString());
}
console.log(JSON.stringify({ at: shifted(1999, 11, 31, 1) }));
const dates = [shifted(2020, 0, 1, 0), shifted(2020, 0, 1, 0)];
dates.forEach((date, index) => date.setTime(date.getTime() + index * 1000));
console.log(dates.map((date) => date.getUTCSeconds()));
