// The regex v flag (unicode sets): class subtraction and intersection, nested
// classes, \q{...} string literals, properties of strings, case folding,
// code-point iteration, and the constructor with literal and computed flags.
// Regex literals report their flags in getter order. Node.js prints the same.
const letters = /[\p{L}--[a-z]]/gv;
console.log(letters.flags, letters.source, String(letters), letters);
console.log("aBcD-É".match(letters));
console.log(/[[a-z]&&[aeiou]]/v.test("e"), /[[a-z]&&[aeiou]]/v.test("b"));
console.log("vowels: education".replace(/[[a-z]&&[^aeiou]]/gv, "_"));
console.log("x😀y".match(/[\q{😀|xy}]/gv), "xy😀".match(/[\q{😀|xy}]/gv));
console.log("abcab".match(/[\q{abc}a]/gv));
console.log(/^\p{RGI_Emoji}$/v.test("👍🏽"), /^\p{RGI_Emoji}$/v.test("a"));
console.log("hi 🇫🇷 1️⃣".match(/\p{RGI_Emoji_Flag_Sequence}|\p{Emoji_Keycap_Sequence}/gv));
console.log("family \u{1F468}\u200D\u{1F469}\u200D\u{1F467} ok".replace(/\p{RGI_Emoji_ZWJ_Sequence}/v, "[zwj]"));
console.log(/[^\d--[5]]/v.test("5"), /[^\d--[5]]/v.test("7"), /[^\d--[5]]/v.test("x"));
console.log(/[[0-9]--[5-9]]+/v.exec("98123")?.[0]);
console.log(/[\p{Lu}--[A-C]]/vi.test("a"), /[\p{Lu}--[A-C]]/vi.test("d"), /[^\p{Lu}]/vi.test("A"));
console.log("😀😀".replace(/(?:)/gv, "-"), "😀😀".split(/(?:)/v));
console.log("a😀b".replace(/./gv, (c) => `<${c}>`));
console.log("A1b2C3".replace(/[\w--\d]/gv, (c) => c.toLowerCase()));
console.log("one, two;three".split(/[[\p{P}\s]--[\-]]+/v));
const m = /(?<word>[\p{L}--\p{Lu}]+)-(?<num>[\d--[0]]+)/v.exec("ABcd-102");
if (m) console.log(m[0], m.index, m.groups?.word, m.groups?.num);
console.log("2024-07".replace(/(?<y>[\d]{4})-(?<mo>\d\d)/v, "$<mo>/$<y>"));

const spelled = /x/vgimsy;
console.log(spelled.flags, String(spelled), /x/yg.flags, /x/mi.flags);
console.log(letters.global, letters.unicodeSets, letters.unicode, letters.ignoreCase, letters.hasIndices);
console.log(spelled.multiline, spelled.dotAll, spelled.sticky, /x/u.unicode, /x/u.unicodeSets);

console.log(new RegExp("[\\w--\\d]", "v").test("5"), new RegExp("[\\w--\\d]", "vg").flags);
const computed = ["v", "gv", "iv"];
for (const flags of computed) {
  const re = new RegExp("[[0-9a-f]--[5]]", flags);
  console.log(flags, re.flags, re.test("5"), re.test("F"));
}
for (const flags of ["uv", "vv"]) {
  try {
    new RegExp("a", flags);
  } catch (e) {
    console.log((e as Error).name, (e as Error).message);
  }
}
const u: unknown = /[\q{abc}]/v;
console.log(u instanceof RegExp, String(u));
// Punctuation that only class contents reserve stays literal outside them.
console.log(/x-y/v.test("x-y"), /a,,b/v.test("a,,b"), /a&&b|!!/v.exec("!!")?.[0], /a--b/v.test("a--b"));
console.log("a-b".match(/[\q{\-}]/gv), "key-value".split(/-/v));
