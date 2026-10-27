// The native implementation covers Unicode grapheme segmentation.
new Intl.Segmenter(["en-US", "de"]);
new Intl.Segmenter(undefined, { granularity: "word" });
new Intl.Segmenter(undefined, { granularity: "sentence" });
// End of the diagnostic fixture.
