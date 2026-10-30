// @requires-icu
// @env: TZ=UTC,LC_ALL=C
// The default locale under LC_ALL=C. ICU's default locale is then its POSIX
// locale (en_US_POSIX), whose number format has no grouping separators. V8
// replaces that locale with en-US, so Node prints grouped numbers and en-US
// date patterns, and so does scr_intl.c.
const xs = [0, 1000, 1234.5, 1234567.891, -9876543.21, 1e21, 0.5];
console.log(xs.map((x) => x.toLocaleString()).join(" | "));
const dates = [new Date(0), new Date(1700000000000), new Date(Date.UTC(2023, 10, 14, 13, 5, 7))];
for (const d of dates) console.log(d.toLocaleString(), "|", d.toLocaleTimeString());

// The default word segmenter reads the same locale.
const words = new Intl.Segmenter(undefined, { granularity: "word" }).segment("It's 1,234.5 apples.");
for (const { segment, isWordLike } of words) console.log(JSON.stringify(segment), isWordLike);
