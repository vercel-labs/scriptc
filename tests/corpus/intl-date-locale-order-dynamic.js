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
