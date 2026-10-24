// Date setters in JavaScript, on Dates held as untyped values: each setter
// converts its arguments with ToNumber (valueOf runs, undefined is NaN) and
// changes the one Date object every alias holds.
process.env.TZ = "Europe/Berlin";

const d = new Date(Date.UTC(2026, 2, 28, 12));
const alias = d;
const box = { d };
console.log(d.setHours(1, 30), d.getHours(), d.getTimezoneOffset());
console.log(alias.setDate(29), box.d.getHours(), d.getTimezoneOffset());
console.log(d.setMinutes("15"), d.setSeconds(true), d.setMilliseconds(null));
console.log(d.setUTCFullYear(2030, 11, 31), d.toISOString());
console.log(d.setMonth(undefined), Number.isNaN(d.getTime()));
console.log(d.setFullYear(2001), d.toISOString());

let calls = 0;
const later = { valueOf() { calls++; return 45; } };
console.log(d.setUTCMinutes(later, later), calls, d.toISOString());

const other = new Date(0);
console.log(other.setHours(5), other.getHours(), typeof d.setMonth);
const list = [new Date(0), new Date(86400000)];
list.forEach((x, i) => x.setUTCHours(i + 1));
console.log(list.map((x) => x.toISOString()).join(" "));
