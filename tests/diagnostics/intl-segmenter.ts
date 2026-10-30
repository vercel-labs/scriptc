// The native implementation covers Unicode grapheme segmentation, and ICU
// answers word segmentation; locale negotiation over several tags and
// sentence segmentation stay fenced.
new Intl.Segmenter(["en-US", "de"]);
new Intl.Segmenter(undefined, { granularity: "word", localeMatcher: "best fit" });
new Intl.Segmenter(undefined, { granularity: "sentence" });
// End of the diagnostic fixture.
