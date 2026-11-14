// @normalize-pid
// util.styleText, util.stripVTControlCharacters and util.toUSVString:
// every format name, the color decision options and environment, the
// control-sequence grammar stripVT removes, and lone-surrogate repair.
import { styleText, stripVTControlCharacters, toUSVString } from "node:util";

const show = (label: string, run: () => unknown): void => {
  try {
    console.log(label, run());
  } catch (e: any) {
    console.log(label, e.name, e.code, e.message);
  }
};

const formats = [
  "reset", "bold", "dim", "italic", "underline", "blink", "inverse", "hidden",
  "strikethrough", "doubleunderline", "black", "red", "green", "yellow", "blue",
  "magenta", "cyan", "white", "bgBlack", "bgRed", "bgGreen", "bgYellow", "bgBlue",
  "bgMagenta", "bgCyan", "bgWhite", "framed", "overlined", "gray", "redBright",
  "greenBright", "yellowBright", "blueBright", "magentaBright", "cyanBright",
  "whiteBright", "bgGray", "grey", "blackBright", "bgGrey", "bgBlackBright",
  "faint", "crossedout", "strikeThrough", "crossedOut", "conceal", "swapColors",
  "swapcolors", "doubleUnderline",
];
for (const format of formats) {
  console.log(format, JSON.stringify(styleText(format as any, "x", { validateStream: false })));
}
console.log(JSON.stringify(styleText(["bold", "underline", "red"], "x", { validateStream: false })));
console.log(JSON.stringify(styleText("red", "", { validateStream: false })));
show("bad format", () => styleText("nope" as any, "x", { validateStream: false }));
show("bad text", () => styleText("red", 42 as any, { validateStream: false }));
show("bad options", () => styleText("red", "x", "bogus" as any));

// Without a color-capable stream the text is unchanged; FORCE_COLOR changes
// that, and NO_COLOR does not override it.
console.log(JSON.stringify(styleText("red", "plain")));
process.env.FORCE_COLOR = "1";
console.log(JSON.stringify(styleText("red", "forced")));
process.env.NO_COLOR = "1";
console.log(JSON.stringify(styleText("red", "both")));
delete process.env.NO_COLOR;
delete process.env.FORCE_COLOR;
console.log(JSON.stringify(styleText("red", "after", { validateStream: false })));
console.log(JSON.stringify(styleText("red", "again")));

const escapes: Array<[string, string]> = [
  ["csi color", "\u001b[31mred\u001b[39m"],
  ["csi clear", "\u001b[2Jtext"],
  ["csi cursor", "\u001b[1;2Htext"],
  ["osc title", "\u001b]0;title\u0007text"],
  ["osc hyperlink", "\u001b]8;;http://x\u0007link\u001b]8;;\u0007"],
  ["osc st", "\u001b]0;title\u001b\\text"],
  ["dcs", "\u001bPq#0;2;0;0;0\u001b\\text"],
  ["unterminated csi", "a\u001b[31"],
  ["unterminated osc", "a\u001b]0;title"],
  ["c1 csi", "\u009b31mred\u009b39m"],
  ["bare esc", "a\u001bb"],
  ["many", "\u001b[1m\u001b[31m\u001b[4mdeep\u001b[0m plain"],
];
for (const [label, text] of escapes) console.log(label, JSON.stringify(stripVTControlCharacters(text)));
show("strip number", () => stripVTControlCharacters(42 as any));
show("strip null", () => stripVTControlCharacters(null as any));

console.log(JSON.stringify(toUSVString("plain")));
console.log(JSON.stringify(toUSVString("a\uD800b")));
console.log(JSON.stringify(toUSVString("a\uDC00b")));
console.log(JSON.stringify(toUSVString("😀")));
console.log(JSON.stringify(toUSVString("\uD83Dx\uDE00")));
console.log(JSON.stringify(toUSVString(42 as any)));
console.log(JSON.stringify(toUSVString("")));
show("toUSVString symbol", () => toUSVString(Symbol() as any));
