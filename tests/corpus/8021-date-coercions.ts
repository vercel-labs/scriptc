// Dates converted to primitives as Node converts them: unary +, Number()
// and relational operators read the time value (the number hint), while +
// with a string, template literals and String() read the text (a Date's
// default hint is a string). Symbol.toPrimitive, valueOf and toString answer
// the same values; == compares two Dates by identity and a Date with a
// primitive through its default primitive. typeof, truthiness and
// instanceof treat a Date as an object, invalid ones included.
export {};
process.env.TZ = "UTC";

const a = new Date(Date.UTC(2026, 9, 23, 8, 30));
const b = new Date(Date.UTC(2026, 9, 24, 8, 30));
const bad = new Date(Number.NaN);

console.log(+a, -a, +b - +a, (+b - +a) / 3600000, Number(a), Math.max(+a, +b) === b.getTime());
console.log(a + "!");
console.log(`at ${a}`);
console.log(String(b));
console.log("" + a === a.toString(), a + "1" === a.toString() + "1");
console.log(a[Symbol.toPrimitive]("number"), a[Symbol.toPrimitive]("string") === a.toString());
console.log(a[Symbol.toPrimitive]("default") === a.toString(), a.valueOf() === a.getTime());
console.log(a < b, a <= b, a > b, a >= b, +b > a.getTime() + 1);

const same = a;
const twin = new Date(a.getTime());
console.log(a == same, a == twin, a === twin, a != twin, a.getTime() === twin.getTime());
console.log(a == (a.toString() as unknown), a == (a.getTime() as unknown));

console.log(typeof a, typeof bad, a instanceof Date, bad instanceof Date);
console.log(Object.prototype.toString.call(a), !a, !!bad, bad ? "truthy" : "falsy");

// Invalid dates.
console.log(+bad, +bad - +a, `${bad}`, String(bad), bad + "", Number.isNaN(bad.getTime()));
console.log(bad.toJSON(), JSON.stringify({ when: bad, at: a }));
try {
  bad.toISOString();
} catch (error) {
  console.log((error as Error).name, (error as Error).message);
}

// Sorting and summing through the number hint.
const days = [b, a, new Date(Date.UTC(2026, 0, 1))];
days.sort((x, y) => +x - +y);
console.log(days.map((x) => x.getUTCDate()).join(","));
let span = 0;
for (let i = 1; i < days.length; i++) span += +days[i]! - +days[i - 1]!;
console.log(span / 86400000);
