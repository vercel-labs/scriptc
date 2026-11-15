// @exit: 1
// The legacy url module's parser over its hostile grid: authority that is
// empty or malformed (missing host, bare ':', out-of-range and overflowing
// ports, unbracketed and unbalanced IPv6 literals, stray text after a
// bracket), whitespace and control characters inside the authority, percent
// escapes that do not decode, unescaped multibyte text in the path, query
// and fragment, userinfo with extra '@' and ':', backslashes standing in for
// slashes, over-long and trailing-dot hostnames, and the schemes whose
// slashes differ (file:, mailto:, data:, javascript:, blob:). Each input is
// parsed twice (with and without parseQueryString), formatted back, and used
// as a reference against a base URL, so the parser, Url.format and
// Url.resolve agree with Node even where the answer is an ERR_INVALID_URL
// throw. DEP0169 and DEP0170 print with a pid, so the @exit directive keeps
// stderr out of the comparison.
import { format, parse, resolve } from "node:url";

const inputs = [
  "http://",
  "http:///",
  "http://?",
  "http://#",
  ":",
  "::",
  "a:",
  "1http://x",
  "ht+tp://x",
  "http://x:99999999999999999999/",
  "http://x:-1/",
  "http://x:65535/",
  "http://x:65536/",
  "http://[::1",
  "http://[]/",
  "http://[::1]:x/",
  "http://[::1]extra/",
  "http://a b/",
  "http://a\tb/",
  "http://a\nb/",
  " http://x/ ",
  " http://x/ ",
  "http://x/%zz",
  "http://x/%",
  "http://x/%c3%28",
  "http://x/ä",
  "http://x/?ä",
  "http://x/#ä",
  "http://user:pa:ss@x/",
  "http://user:p@ss@x/",
  "http://a@b@c/",
  "http://%40@x/",
  "http://x\\y",
  "http:\\x\\y",
  "http://x/y\\z",
  "http://x./",
  "http://.x/",
  "http://x..y/",
  "http://xn--nxasmq6b.example/",
  `http://${"a".repeat(300)}/`,
  "http://x/?a=1&a=2&a",
  "http://x/?%61=1",
  "http://x/?a+b=c+d",
  "http://x/?a=%00",
  "http://x/?a=",
  "http://x/?&&",
  "http://x/?a=1&",
  "//x",
  "///x",
  "////x",
  "//x:1/",
  "//[::1]/",
  "//x?a",
  "//x#a",
  "file:x",
  "file:/x",
  "file://x/y",
  "file:////y",
  "file:\\\\x\\y",
  "mailto:",
  "mailto:?a",
  "data:text/plain,hi",
  "urn:isbn:1",
  "tel:+1-2",
  "javascript:",
  "about:blank",
  "blob:http://x/y",
];

for (const input of inputs) {
  let line: string;
  try {
    line = JSON.stringify(parse(input));
  } catch (e) {
    const err = e as Error & { code?: string };
    line = `throw ${err.name} ${err.code}`;
  }
  console.log(JSON.stringify(input), "=>", line);
  try {
    console.log("  query", JSON.stringify(parse(input, true).query));
  } catch (e) {
    console.log("  query throw", (e as Error).name);
  }
  try {
    console.log("  format", JSON.stringify(format(parse(input))));
  } catch (e) {
    console.log("  format throw", (e as Error).name);
  }
  try {
    console.log("  resolve", JSON.stringify(resolve("http://base/a/b", input)));
  } catch (e) {
    console.log("  resolve throw", (e as Error).name);
  }
}
process.exitCode = 1;
