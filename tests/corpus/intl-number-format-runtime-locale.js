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
