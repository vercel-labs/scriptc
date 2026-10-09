// Regex results on one-byte (ASCII) subjects, which run the native matcher
// translated from libregexp bytecode, next to non-ASCII twins of the same
// subjects, which keep the libregexp interpreter. Covers every translated
// construct: literal runs, classes, single-character loops (greedy, lazy,
// counted, possessive), groups, alternation, counted and empty-checked group
// loops, anchors, word boundaries, flags, lastIndex, and empty matches.

function show(m: RegExpExecArray | null): string {
  if (m === null) return "null";
  const parts: string[] = [];
  for (let i = 0; i < m.length; i++) parts.push(m[i] === undefined ? "<u>" : JSON.stringify(m[i]));
  return `@${m.index} [${parts.join(", ")}]`;
}

function both(label: string, re: RegExp, subject: string): void {
  re.lastIndex = 0;
  const ascii = show(re.exec(subject));
  re.lastIndex = 0;
  const wide = show(re.exec(subject + "\u00e9"));
  console.log(label, ascii, "|", wide);
}

// Literals and literal runs (memchr prefilter, memcmp runs).
both("lit", /&/, "R&D and more");
both("run", /HTTP\/1\.1/, 'GET / HTTP/1.1" 200');
both("run-miss", /HTTP\/2/, "HTTP/1.1 HTTP/1.0");
both("alt", /curl|bot|spider/, "Mozilla curl/8.4.0");
both("alt-i", /curl|bot|spider/i, "a SPIDER and a BoT");

// Single-character loops.
both("plus", /\d+/, "id=12345 next=6");
both("star", /a*b/, "caaab");
both("star-empty", /x*/, "abc");
both("opt", /colou?r/, "my color");
both("lazy", /<.+?>/, "<b>bold</b>");
both("lazy-star", /a.*?c/, "abcbc");
both("count", /\d{3}/, "12 345 6789");
both("range", /\d{2,4}/, "1 12345");
both("range-lazy", /\d{2,4}?/, "12345");
both("zero-n", /x{0,2}y/, "xxxy");
both("at-least", /a{2,}/, "a aa aaaa");
both("backtrack", /\w+\d/, "abc123x");
both("backtrack-lazy", /\w+?\d/, "abc123x");
both("class-neg", /\[([^\]]+)\]/, "x [07/Oct/2026:12:00:00 +0000] y");

// Groups, alternation, captures that do not participate.
both("groups", /(a|ab)(c|bcd)(d*)/, "abcd");
both("optional-group", /a(x)?c/, "ac");
both("opt-capture", /(\w+)(?:\?([^ ]*))? HTTP/, "/api/items?id=42 HTTP");
both("opt-capture-miss", /(\w+)(?:\?([^ ]*))? HTTP/, "/health HTTP");
both("nested", /((a)|(b))+/, "abab");
both("reset", /(?:(a)|b)+/, "ab");
both("group-star", /(?:ab)*c/, "ababc");
both("group-count", /(?:ab){2}/, "abababab");
both("group-range", /(ab){1,2}?c/, "ababc");
both("empty-check", /(?:a+|b)*c/, "aababbc");
both("empty-loop", /(a*)*b/, "aab");
both("empty-alt", /(?:x|)*y/, "xxy");

// Anchors, multiline, word boundaries.
both("bol", /^\d+/, "42 is the answer");
both("bol-miss", /^\d+/, "the answer is 42");
both("eol", /\d+$/, "answer 42");
both("bol-m", /^b\w*/m, "alpha\nbeta");
both("eol-m", /a$/m, "alpha\nbeta");
both("bol-cr", /^b/m, "a\rb");
both("word", /\bcat\b/, "concat cat category");
both("nonword", /\Bcat\B/, "concat cat category");
both("dot", /a.b/, "a\nb axb");
both("dotall", /a.b/s, "a\nb");
both("space", /\s+/, "a \t\n b");

// Case folding on ASCII subjects (long s and the Kelvin sign fold to s/k
// only under /iu).
both("fold", /[a-z]+/i, "123 HeLLo");
both("long-s", /\u017f/i, "s S");
both("long-s-u", /\u017f/iu, "s S");
both("kelvin-u", /\u212a/iu, "k K");
both("class-fold-u", /[\u212a]/iu, "k");
both("neg-fold", /[^a]/i, "aA");
both("unicode", /\w+/u, "abc def");

// Whole log line with eight captures.
const linePattern = /^(\d+\.\d+\.\d+\.\d+) - - \[([^\]]+)\] "(\w+) ([^ ?"]+)(?:\?([^ "]*))? HTTP\/1\.1" (\d{3}) (\d+) "([^"]*)"$/;
both("line", linePattern, '10.1.2.3 - - [07/Oct/2026:12:00:00 +0000] "GET /api/items/search?id=42 HTTP/1.1" 200 17 "curl/8.4.0"');
both("line-noquery", linePattern, '10.1.2.3 - - [07/Oct/2026:12:00:00 +0000] "POST /health HTTP/1.1" 500 9 "Mozilla/5.0 (Macintosh)"');

// Global and sticky state.
const g = /\d+/g;
const seen: string[] = [];
let m: RegExpExecArray | null;
while ((m = g.exec("a1 b22 c333")) !== null) seen.push(`${m[0]}@${m.index}->${g.lastIndex}`);
console.log("global", seen.join(" "), g.lastIndex);
const y = /\d/y;
console.log("sticky", y.test("1a2"), y.lastIndex, y.test("1a2"), y.lastIndex, y.test("1a2"), y.lastIndex);
const gy = /a/gy;
console.log("sticky-global", "aaba".replace(gy, "x"), "baaa".replace(gy, "x"));
const late = /b/g;
late.lastIndex = 2;
console.log("last-index", late.test("abcb"), late.lastIndex, late.test("abcb"), late.lastIndex);
late.lastIndex = 9;
console.log("past-end", late.test("abcb"), late.lastIndex);

// Empty matches advance one unit at a time.
console.log("empty-g", "abc".replace(/x*/g, "-"), JSON.stringify("abc".match(/x*/g)));
console.log("empty-g-wide", "a\u00e9c".replace(/x*/g, "-"));

// String APIs.
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
console.log("escape", escapeHtml('<b>"R&D"</b> plain'), escapeHtml("caf\u00e9 <&>"));
console.log("redact", "10.1.2.3 GET 200 17".replace(/\d+/g, "#"), "caf\u00e9 42".replace(/\d+/g, "#"));
console.log("subst", "john smith".replace(/(\w+)\s(\w+)/, "$2, $1"), "x-y".replace(/(?<a>\w)-(?<b>\w)/, "$<b>$<a>$&$$"));
console.log("callback", "a1b22".replace(/\d+/g, (d) => `[${d.length}]`));
console.log("match", JSON.stringify("a1b22c333".match(/\d+/g)), JSON.stringify("none".match(/\d+/g)));
console.log("matchAll", [..."k1=v1;k2=v2".matchAll(/(\w)(\d)=(\w+)/g)].map((x) => `${x[1]}${x[2]}=${x[3]}`).join(" "));
console.log("split", JSON.stringify("a, b,c ,d".split(/\s*,\s*/)), JSON.stringify("a1b2c".split(/(\d)/)));
console.log("search", "hello world".search(/o\s/), "hello".search(/z/), "caf\u00e9 bar".search(/a\w/));
console.log("replaceAll", "a.b.c".replaceAll(/\./g, "/"));
const dated = /(?<year>\d{4})-(?<month>\d{2})/;
const date = dated.exec("on 2026-10-08");
if (date) console.log("named", date.groups!.year, date.groups!.month, date.index);

// Constructed regexes take the same path.
const built = new RegExp("(\\w+)@(\\w+)\\.com", "g");
console.log("constructed", "ann@example.com, bob@test.com".replace(built, "$2:$1"));

// Lookaround and back references keep the interpreter on every subject.
both("lookahead", /\d+(?=px)/, "10em 20px");
both("lookbehind", /(?<=\$)\d+/, "cost $42");
both("backref", /(\w)\1/, "abccd");
