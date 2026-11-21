// A pattern that is only alternatives of literal ASCII characters and
// single-character classes is scanned directly: the first byte position where
// an alternative matches, with the alternatives tried in source order. The
// patterns below are built at run time, so the compiler cannot replace them
// with a literal instance (those keep their build-time matcher); the answers
// must be the engine's.
const alternation = ["ggt", "ggta"].join("|");
const reversed = ["ggta", "ggt"].join("|");
const text = "ggtacggtaTTggt";

console.log(text.match(new RegExp(alternation, "g")));
console.log(text.match(new RegExp(reversed, "g")));
console.log("ab".match(new RegExp(["a", "ab"].join("|"))));
console.log("zab".match(new RegExp(["ab", "a"].join("|"))));
console.log("abab".match(new RegExp(["ab", "a"].join("|"), "g")));
console.log("xxabyy".replace(new RegExp(["a", "ab"].join("|")), "Q"));
console.log("xxabyy".replace(new RegExp(["a", "ab"].join("|"), "g"), "Q"));
console.log("a1bb2ccc".split(new RegExp(["a", "bb", "ccc"].join("|"))));
console.log("ABC".match(new RegExp(["a", "b"].join("|"), "g")));
console.log("héllo gg".match(new RegExp(["gg", "h"].join("|"), "g")));
console.log("héllo gg".replace(new RegExp(["gg", "h"].join("|"), "g"), "#"));

// Character classes and ranges in the alternatives.
console.log("acgggtaaattccct".match(new RegExp("[cgt]gggtaaa|tttaccc[acg]", "g")));
console.log("x1y22z".match(new RegExp("[0-9]+|x", "g")));
console.log("foo bar".match(new RegExp("foo|b[aeiou]r", "g")));
console.log("ab12cd34".replace(new RegExp("[0-9][0-9]", "g"), "<$&>"));

const global = new RegExp(alternation, "g");
console.log(global.exec(text), global.lastIndex);
console.log(global.exec(text), global.lastIndex);
console.log(global.exec(text), global.lastIndex);

console.log("".match(new RegExp(["a", "b"].join("|"), "g")));
console.log("aaa".match(new RegExp(["aa", "a"].join("|"), "g")));
console.log("xggtax".search(new RegExp(["ggta", "ggt"].join("|"))));

// Empty alternatives match the empty string; those patterns keep the engine.
console.log("xa".match(new RegExp(["a", ""].join("|"), "g")));
console.log("xa".match(new RegExp(["", "a"].join("|"), "g")));
console.log("xa".replace(new RegExp(["a", ""].join("|"), "g"), "-"));

// An escaped upper endpoint is a class escape, not a literal backslash: the
// pattern keeps the engine's answer, so removing everything but digits does
// not let angle brackets through.
console.log("<12>".replace(new RegExp("[^0-\\x39]", "g"), ""));
console.log("a-b_c".replace(new RegExp("[\\x41-\\x5a]+", "g"), ""));
