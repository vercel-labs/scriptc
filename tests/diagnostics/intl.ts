// The Intl surface. What compiles: Intl.NumberFormat and Intl.DateTimeFormat
// objects with their options and format(), the toLocaleString(),
// toLocaleDateString() and toLocaleTimeString() forms that construct them,
// and Intl.Segmenter (corpus 9381 to 9390), at the default locale, "en-US"
// or "en". Everything else fences by NAME: other locales and lists of
// locales (locale negotiation), the formatter members other than format,
// BigInt inputs, another calendar, and the rest of the Intl namespace
// (DurationFormat, PluralRules, getCanonicalLocales).

// Locales the compiler does not take.
declare const tag: string;
const otherLocale = new Intl.NumberFormat("de-DE").format(1234.5);
const negotiated = new Intl.NumberFormat(tag).format(1234.5);
const listed = new Intl.NumberFormat(["en-US", "de-DE"]).format(1234.5);
const german = (1234.5).toLocaleString("de-DE");
const french = new Intl.DateTimeFormat("fr-FR").format();
const dated = new Date(0).toLocaleDateString("ja-JP", { year: "numeric" });

// Members and inputs the formatters do not have.
const parts = new Intl.NumberFormat("en-US").formatToParts(1234.5);
const big = new Intl.NumberFormat("en-US", {}).format(12n);
const range = new Intl.DateTimeFormat("en-US").formatRange(0, 1);
const buddhist = new Intl.DateTimeFormat("en-US", { calendar: "buddhist" }).format(0);

// The rest of Intl keeps the ICU story.
const dur = new Intl.DurationFormat("en-US").format({ hours: 1, minutes: 23 });
const rule = new Intl.PluralRules("en-US").select(1);
const canon = Intl.getCanonicalLocales("en-us");
