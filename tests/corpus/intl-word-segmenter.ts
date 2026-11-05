// @requires-icu
// @env: LC_ALL=en_US.UTF-8
// Intl.Segmenter({ granularity: "word" }) — ICU's UAX #29 word break
// iterator (scr_intl.c over the ICU archive), which is the one
// Intl form pi's tui layer needs: the segments carry isWordLike, exactly as
// Node's do. Word boundaries at the default locale and under a locale tag,
// punctuation and digits, re-iteration, and the containing() lookup all pin
// byte-identically against Node.
const text = "Hello, world! It's 3.14 — don't stop, Übermensch.";
const segments = new Intl.Segmenter(undefined, { granularity: "word" }).segment(text);
for (const { segment, index, input, isWordLike } of segments) {
  console.log(JSON.stringify(segment), index, input === text, isWordLike);
}

// The same input through a locale tag: German word breaking is still
// UAX #29 root rules at heart, but the segmenter must accept the tag.
const german = new Intl.Segmenter("de", { granularity: "word" }).segment("Straße 42, größer.");
let words = "";
let wordCount = 0;
for (const part of german) {
  if (part.isWordLike === true) {
    words += `${wordCount === 0 ? "" : "|"}${part.segment}`;
    wordCount += 1;
  }
}
console.log(words, wordCount);

// Re-iterating one Segments object restarts from the first segment.
const again = new Intl.Segmenter("en", { granularity: "word" }).segment("one two");
let first = "";
for (const part of again) first += `[${part.segment}]`;
let second = "";
for (const part of again) second += `[${part.segment}]`;
console.log(first, second, first === second);

// containing() answers the segment covering a position and undefined past
// the end, the same contract as the grapheme segmenter's.
const lookup = new Intl.Segmenter("en", { granularity: "word" }).segment("a b");
for (const position of [-1, 0, 1, 2, 3, 4]) {
  const result = lookup.containing(position);
  console.log(
    position,
    result === undefined ? "none" : `${result.index}:${result.segment}:${result.isWordLike}`,
  );
}
