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
