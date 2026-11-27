// A relative pathname pattern resolves against the base URL's directory as
// literal text: the directory's pattern metacharacters are escaped, so the
// directory cannot act as pattern syntax and the pattern cannot match outside
// it.
const bases = [
  "https://example.com/a(b)/",
  "https://example.com/a*b/",
  "https://example.com/a+b/",
  "https://example.com/a:b/",
  "https://example.com/a{b}/",
];
for (const base of bases) {
  const pattern = new URLPattern({ pathname: "x", baseURL: base });
  console.log(
    JSON.stringify(base),
    JSON.stringify(pattern.pathname),
    pattern.test(base + "x"),
    pattern.test("https://example.com/ab/x"),
  );
}

// A directory's metacharacters cannot hide the slash behind them either: an
// unmatched "(" would otherwise swallow the separator that follows it and
// shift the ".." arithmetic above the intended directory.
const relatives = [
  ["x", "https://example.com/a(/b/"],
  ["../x", "https://example.com/a(/b/"],
  ["./x", "https://example.com/a(/b/"],
];
for (const [rel, base] of relatives) {
  const pattern = new URLPattern({ pathname: rel, baseURL: base });
  console.log(
    JSON.stringify(rel),
    JSON.stringify(base),
    JSON.stringify(pattern.pathname),
    pattern.test(new URL(rel, base).href),
    pattern.test("https://example.com/ab/" + rel),
  );
}
