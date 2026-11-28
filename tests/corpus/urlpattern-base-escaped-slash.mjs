// An escaped slash in an explicit pathname pattern is fixed text, and a base
// must not move it: a leading `\/` starts the path (so the base's directory
// does not apply), and a part right after one is wrapped in a group, so a
// `+`, `?` or `*` repeats that part inside its segment instead of matching
// across segments (which would widen the pattern to nested and parent paths).
const base = "https://example.com/a/";
const urls = [
  "https://example.com/a/x/b",
  "https://example.com/a/x/b/c",
  "https://example.com/a/x/b/c/d",
  "https://example.com/a/b",
  "https://example.com/a",
  "https://example.com/b",
  "https://example.com/a/x/",
  "https://example.com/a/x/b/tail",
  "https://example.com/a/a/b",
  "https://example.com/a/12",
  "https://example.com/a/1/2",
];
const patterns = [
  "x\\/:id+",
  "x\\/:id",
  "x\\/:id?",
  "x\\/:id*",
  "x\\/*",
  "x\\/a:id",
  "x\\/:id-:rest",
  "x\\/:id\\/y",
  "a\\/(\\d+)",
  "a\\/b",
  "\\/:id+",
  "\\/:id",
  "\\/a",
  "\\/:id+/tail",
  "\\/\\/:id+",
  "\\/x\\/:id+",
  "\\/",
];
for (const pattern of patterns) {
  try {
    const compiled = new URLPattern(pattern, base);
    console.log(
      JSON.stringify(pattern),
      JSON.stringify(compiled.pathname),
      JSON.stringify(urls.map((url) => compiled.test(url))),
    );
  } catch (error) {
    console.log(JSON.stringify(pattern), "throws", error.name);
  }
}
const fromRecord = new URLPattern({ pathname: "x\\/:id+", baseURL: base });
console.log(
  "record",
  JSON.stringify(fromRecord.pathname),
  JSON.stringify(urls.map((url) => fromRecord.test(url))),
);
