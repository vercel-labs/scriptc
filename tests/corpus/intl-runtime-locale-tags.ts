// @requires-icu
// Date.prototype.toLocale* and the Intl formatters with a locale the program
// decides at run time: the runtime validates the tag with ECMA-402's grammar
// (Node's RangeError for a malformed one), canonicalizes its language aliases
// as Node does, negotiates it against ICU's locales as Node's best fit does,
// and formats with that locale's data. The tags below cover right-to-left,
// non-Gregorian and non-Latin numbering, a tag ICU has no locale for (the
// default locale), deprecated and overlong language codes (iw, bih), aliases
// whose canonical form adds a script or region (sh -> sr-Latn, cnr -> sr-ME,
// prs -> fa-AF, sh-RS -> sr-Latn-RS) and a Unicode extension.
const at = Date.UTC(2020, 0, 2, 15, 4, 5);
const d = new Date(at);
const tags = [
  "en-US",
  "en",
  "de-DE",
  "fr-FR",
  "ja-JP",
  "ar-EG",
  "zh-TW",
  "es-419",
  "ru-RU",
  "hi-IN",
  "pt-BR",
  "iw",
  "bih",
  "sh",
  "sh-RS",
  "cnr",
  "cnr-RS",
  "prs",
  "sr-Latn-RS",
  // Tags Node's matcher resolves by dropping subtags rather than by locale
  // distance: en-RU has no date data (Node answers en), hak has no locale at
  // all (Node answers the default locale).
  "en-RU",
  "hak",
  // Territory and script aliases canonicalize before matching (en-UK is
  // en-GB, de-DD is de-DE), as Node's CanonicalizeUnicodeLocaleId does.
  "en-UK",
  "de-DD",
  "en-Qaai",
  "EN-us",
  "xx-YY",
  "en-US-u-nu-latn",
];
for (const spelled of tags) {
  const locale: string = spelled;
  console.log(spelled);
  console.log(" time", d.toLocaleTimeString(locale));
  console.log(" date", d.toLocaleDateString(locale));
  console.log(" both", d.toLocaleString(locale));
  console.log(" number", (1234.5).toLocaleString(locale));
  console.log(" named", d.toLocaleDateString(locale, { weekday: "long", month: "long" }));
  console.log(" dtf", new Intl.DateTimeFormat(locale).format(d));
  console.log(" nf", new Intl.NumberFormat(locale).format(1234.5));
}

// A locale value typed `string | undefined`: undefined takes the default
// locale, and a string is validated like any other.
const absent: string | undefined = process.env["SCRIPT_C_NO_SUCH_LOCALE"];
const present: string | undefined = process.env["SCRIPT_C_NO_SUCH_LOCALE"] ?? "de-DE";
console.log("absent", d.toLocaleDateString(absent));
console.log("present", d.toLocaleDateString(present as string), (1234.5).toLocaleString(present as string));

// Malformed tags raise Node's RangeError, catchably.
for (const bad of ["", "en_US", "x-private", "abcd", "en--US", "root", "en-a-bb-a-cc", "en-x", "de-DE-1901-1901", "sl-rozaj-rozaj"]) {
  try {
    console.log("bad", JSON.stringify(bad), "->", d.toLocaleTimeString(bad));
  } catch (error) {
    console.log("bad", JSON.stringify(bad), "->", (error as Error).name);
  }
}
try {
  d.toLocaleTimeString("en_US");
} catch (error) {
  console.log("message", (error as Error).message);
}
// The empty string is a locale the runtime rejects, not the default locale.
try {
  d.toLocaleTimeString("");
} catch (error) {
  console.log("empty", (error as Error).name);
}

// A locale expression runs in its argument position: one that changes the
// Date changes the time value the formatter reads afterwards.
const mutated = new Date(Date.UTC(2020, 0, 2, 15, 4, 5));
console.log(
  "mutated",
  mutated.toLocaleTimeString(
    (() => {
      mutated.setTime(Date.UTC(2021, 5, 6, 7, 8, 9));
      return "de-DE";
    })(),
  ),
);

// The options argument still reaches the resolved locale's formatter, and an
// invalid Date answers before the locale is looked at.
console.log("styled", d.toLocaleDateString("ja-JP", { year: "numeric", month: "long" }));
console.log("money", (1234.5).toLocaleString("de-DE", { minimumFractionDigits: 2 }));
console.log("invalid", new Date(Number.NaN).toLocaleTimeString("bad_tag"));
