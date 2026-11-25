// A NumberFormat locale can be a string the program holds: ICU canonicalizes
// it, and a structurally invalid tag throws Node's RangeError.
function format(value, locale) {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
}
console.log("en", format(1234.5, "en-US"));
console.log("de", format(1234.5, "de-DE"));
let tag = "fr-FR";
console.log("fr", format(1234.5, tag));
console.log("ja", format(1234.5, "ja-JP"));
try {
  new Intl.NumberFormat("not a tag!");
  console.log("invalid", "no throw");
} catch (error) {
  console.log("invalid", error.name, error.message);
}
try {
  new Intl.NumberFormat("en_US");
  console.log("underscore", "no throw");
} catch (error) {
  console.log("underscore", error.name, error.message);
}

// The locale argument evaluates where it stands: a locale expression that
// moves the Date is seen by the formatter's own time read.
const stamped = new Date(0);
console.log("order", stamped.toLocaleDateString((stamped.setTime(86400000), "en-US")));

// An undefined locale value selects the default locale, as Node does; a
// computed string is used as given.
function formatIn(locale) {
  return new Intl.NumberFormat(locale).format(1234.5);
}
console.log("undefined-locale", formatIn(undefined));
console.log("runtime-locale", formatIn("de-DE"));
