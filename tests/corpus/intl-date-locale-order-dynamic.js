// A checked-dynamic Date (a JavaScript file's Date) reads its time value
// after the locale and options arguments, so an argument that moves the
// Date is seen by the formatter, as in Node.
const date = new Date(0);
console.log("order", date.toLocaleDateString((date.setTime(86400000), "en-US")));
const second = new Date(0);
console.log(
  "options",
  second.toLocaleString((second.setTime(86400000), "en-US"), {
    timeZone: "UTC",
    hour12: false
  })
);

// An empty tag is Node's RangeError, raised when the formatter is built —
// after every argument expression has evaluated — and an invalid Date still
// answers "Invalid Date" first.
let evaluated = 0;
try {
  new Intl.NumberFormat("", (evaluated++, {}));
  console.log("empty", "no throw");
} catch (error) {
  console.log("empty", error.name, evaluated);
}
console.log("invalid-date", new Date(NaN).toLocaleDateString(""));

// A computed locale is canonicalized only after the time-value check: an
// invalid Date answers "Invalid Date" without reading it (or the options),
// while a valid Date takes the same errors a literal locale would.
const invalid = new Date(NaN);
console.log("invalid-null-locale", invalid.toLocaleDateString(JSON.parse("null")));
const throwingOptions = {
  get timeZone() {
    throw new Error("options read");
  }
};
console.log("invalid-options", invalid.toLocaleString("en-US", throwingOptions));
try {
  new Date(0).toLocaleDateString(JSON.parse("null"));
  console.log("valid-null-locale", "no throw");
} catch (error) {
  console.log("valid-null-locale", error.name, error.message);
}
