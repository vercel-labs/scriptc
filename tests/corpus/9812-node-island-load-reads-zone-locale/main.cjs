// @requires-libnode
// Island packages whose load reads the machine's time zone or its default
// locale: Intl defaults, a date string without a zone, a Date's local
// fields, toLocaleString(), localeCompare(). The build's load recorder did
// not list these, so the executable answered with the BUILD machine's zone
// and locale wherever it ran. The default locale is now a boot guard on the
// variables ICU takes it from; the time zone of a machine whose TZ is unset
// has no guard, and such a load evaluates where it is imported. A load that
// names its zone and its locale reads neither and still waits. The two
// that wait are imported first: a load imported after one that evaluates
// where it is imported evaluates at its import as well.
const fixed = require("fixed-kit");
const locale = require("locale-kit");
const zone = require("zone-kit");
const calendar = require("calendar-kit");
const seen = require("seen-kit");

console.log("zone:", zone.zone);
console.log("local midnight:", zone.midnight, zone.legacy, calendar.made);
console.log("offset:", calendar.offset, seen.offset);
console.log("hour:", calendar.hour);
console.log("text:", calendar.text);
console.log("day:", calendar.day);
console.log("utc member:", typeof calendar.utc);
console.log("locale:", locale.locale, locale.fallback);
console.log("numbers:", locale.number, locale.big);
console.log("sorted:", locale.sorted);
console.log("list:", locale.list, "|", locale.region);
console.log("fixed:", fixed.parsed, fixed.iso, fixed.hour, fixed.text, fixed.number, fixed.order);
