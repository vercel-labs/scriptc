// A constructed RegExp's source is the text between the slashes of a
// literal for the same pattern: a '/' outside a class takes a backslash, a
// line terminator becomes its escape, and the empty pattern is (?:).
const patterns = ["/", "a/b", "", "\n", "\r", "\u2028", "\u2029", "[/]", "\\/", "\\\n", "[\n]", "a\\\\/b", "[\\]/]", "\\[/", "/\n/", "(?:)", "\t", "\\n", "é/ü", "[a/\\]/]/"];
for (const pattern of patterns) {
  const re = new RegExp(pattern);
  console.log(JSON.stringify(re.source), JSON.stringify(String(re)), JSON.stringify(re.toString()), JSON.stringify(`${re}`));
}
console.log(new RegExp("/", "gi").source, new RegExp("a/b", "g").flags, new RegExp("/", "y").toString());
console.log(new RegExp(/a\/b/).source, new RegExp(/x/g, "i").source, /\//.source, /[/]/.source, /a\nb/.source);
const copy = new RegExp(new RegExp("p/q"));
console.log(copy.source, String(copy), copy.test("p/q"), new RegExp("\n").test("\n"), new RegExp("\u2028").test("\u2028"));
console.log(new RegExp("a/b").test("a/b"), "x/y/z".replace(new RegExp("/", "g"), "-"), "l1\nl2".split(new RegExp("\n")).length);
console.log(new RegExp("/"));
console.log([new RegExp("a/b"), new RegExp("")], { re: new RegExp("\n", "m") });
const dynamic: unknown = new RegExp("u/v");
console.log(String(dynamic), (dynamic as RegExp).source);
try {
  new RegExp("a/(");
} catch (error) {
  console.log(error instanceof SyntaxError, (error as Error).message.startsWith("Invalid regular expression: /a/(/"));
}
