// WHATWG URL hosts that hold non-ASCII text, directly or after
// percent-decoding, go through UTS #46 ToASCII as the host parser in Node
// does: mapped and normalized labels become Punycode, and disallowed code
// points, invalid joiners and bidi violations make the URL invalid. Cases
// from the WPT url test data, plus setters, pathToFileURL UNC hosts and
// URL.canParse.
import url from "node:url";

const parses = [
  ["http://é@é", null],
  ["http://GOO\u200B\u2060\uFEFFgoo.com", "http://other.com/"],
  ["http://www.foo。bar.com", "http://other.com/"],
  ["http://Ｇｏ.com", "http://other.com/"],
  ["http://你好你好", "http://other.com/"],
  ["https://faß.ExAmPlE/", null],
  ["http://０Ｘｃ０．０２５０．０１", "http://other.com/"],
  ["ftp://%e2%98%83", null],
  ["https://%e2%98%83", null],
  ["file://a\u00ADb/p", null],
  ["file://a%C2%ADb/p", null],
  ["file://loC𝐀𝐋𝐇𝐨𝐬𝐭/usr/bin", null],
  ["https://a%C2%ADb/", null],
  ["http://münchen.de/straße", null],
  ["https://日本語.jp/", null],
  ["http://例え.テスト/", null],
  ["http://xn--mnchen-3ya.de/", null],
  ["http://a\u200Db.com/", null],
  ["http://אa.com/", null],
  ["http://ab�c/", null],
  ["ws://ÉXAMPLE.org:8080/x", null],
];
function describe(value) {
  return [value.href, value.host, value.hostname, value.origin].join(" | ");
}
for (const [input, base] of parses) {
  let line;
  try {
    line = describe(base === null ? new URL(input) : new URL(input, base));
  } catch (e) {
    line = `throws ${e.code}`;
  }
  console.log(JSON.stringify(input), "=>", line, URL.canParse(input, base ?? undefined));
}
const writes = [
  ["host", "https://x/", "ß"],
  ["host", "https://example.com/", "a%C2%ADb"],
  ["hostname", "https://example.com/", "a%C2%ADb"],
  ["hostname", "https://example.com/", "BÜCHER.example"],
];
for (const [name, href, value] of writes) {
  const target = new URL(href);
  if (name === "host") target.host = value;
  else target.hostname = value;
  console.log(name, JSON.stringify(value), "=>", describe(target));
}
for (const path of ["\\\\münchen\\share\\f", "\\\\BÜCHER\\s\\f"]) {
  console.log(JSON.stringify(path), url.pathToFileURL(path, { windows: true }).href);
}
