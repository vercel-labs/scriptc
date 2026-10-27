// Dates held in untyped JavaScript values convert like Node's: string
// conversions use toString() (String, templates, +, ==, join), number
// conversions use the time value (Number, BigInt, unary +, -, *, <, >=),
// and toString, toDateString and toTimeString are callable as methods and
// as function values.
process.env.TZ = "America/Chicago";
const date = new Date(Date.UTC(2026, 9, 18, 14, 12, 30));
const held = [date, new Date(NaN), new Date(0)];
const x = /** @type {any} */ (held[0]);
const bad = /** @type {any} */ (held[1]);
const zero = /** @type {any} */ (held[2]);

console.log(String(x));
console.log(`${x} / ${bad}`);
console.log(x.toString(), "|", x.toDateString(), "|", x.toTimeString());
console.log(held.join(" ; "));
console.log(x + 1, "|", 1 + x, "|", x + "");
console.log(+x, x - 0, x * 1, Number(x), Number(bad), BigInt(zero));
console.log(x > 5, x < zero, x >= x, x <= 1792332720000, bad < x, bad >= x);
console.log(x == x.toString(), x == 1792332750000, zero == "0");

const toTime = x.toTimeString;
const toDate = x.toDateString;
console.log(toTime.call(x), "|", toDate.call(zero));

process.env.TZ = "Asia/Kathmandu";
console.log(String(x), "|", [x, zero].toString());
process.env.TZ = "Europe/Dublin";
console.log(`${zero}`, "|", zero.toTimeString());
