// String.prototype.substr, the locale case pair and the Annex B HTML
// methods on typed strings. substr counts a negative start from the end
// and clamps its length; toLocaleLowerCase/toLocaleUpperCase use the
// default case conversion except for the Turkic languages, decided by the
// first requested locale only; the HTML methods escape '"' in attribute
// values.
const s = "Hello, World";
console.log(s.substr(0), s.substr(7), s.substr(-5), s.substr(-50, 3), s.substr(3, 4));
console.log(JSON.stringify([s.substr(20), s.substr(2, -1), s.substr(NaN, 2), s.substr(1, Infinity)]));
console.log(JSON.stringify([s.substr(-Infinity, 2), s.substr(1.9, 2.9), "😀ab".substr(1, 2)]));
function tail(from: number, length?: number): string {
  return s.substr(from, length);
}
console.log(tail(2), tail(2, 3), tail(-3, undefined));

function lower(text: string, locale?: string | string[]): string {
  return text.toLocaleLowerCase(locale);
}
function upper(text: string, locale?: string | string[]): string {
  return text.toLocaleUpperCase(locale);
}
const sample = "IİiıÍ ΣΑΣ Straße";
for (const locale of [undefined, "en", "en-US", "de-DE", "TR", "tr-TR", "az", "tur", "zh-Hant-TW", "und", "en-u-co-phonebk", "en-x-tr"]) {
  console.log(String(locale), lower(sample, locale), upper(sample, locale));
}
console.log(lower(sample, ["tr", "en"]), lower(sample, ["en", "tr"]), lower(sample, []));
console.log(upper("istanbul", ["az"]), lower("DİYARBAKIR"), lower("İx", "tr").length);
console.log("ǅ".toLocaleUpperCase(), "ß".toLocaleUpperCase("de"), "ﬃ".toLocaleUpperCase("en"));


console.log(s.anchor('a"b'), s.big(), s.blink(), s.bold(), s.fixed());
console.log(s.fontcolor("red"), s.fontsize(7), s.italics(), s.link("https://x/?q=\"1\""));
console.log(s.small(), s.strike(), s.sub(), s.sup(), "".anchor(""));
