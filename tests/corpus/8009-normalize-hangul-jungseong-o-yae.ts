// U+11A7 (HANGUL JUNGSEONG O-YAE) is a vowel that composes with nothing:
// after an LV syllable, after a leading consonant, and around trailing
// consonants it stays as it is in every normalization form, as in Node.

const samples = [
  "가ᆧ",
  "가ᆧ",
  "가ᆧᆨ",
  "각ᆧ",
  "ᄀᆧ",
  "ᆧ",
  "ᆧᆧ",
  "x가ᆧy각z",
  "café 가ᆧ é",
  "ｶﾞᆧ가",
];

function points(text: string): string {
  return Array.from(text, (ch) => ch.codePointAt(0)!.toString(16)).join(".");
}

for (const sample of samples) {
  console.log(
    points(sample),
    ["NFC", "NFD", "NFKC", "NFKD"].map((form) => points(sample.normalize(form))).join(" "),
  );
}
console.log("가ᆧ".normalize() === "가ᆧ", "가ᆧ".normalize().length);
