// node:url's namespace functions as Node 24 defines them: the IDNA
// entry points over valid and invalid domains (an invalid domain answers
// the empty string rather than throwing), format() of a URL with each
// option, and the http.request options a URL maps to.
import { domainToASCII, domainToUnicode, format, urlToHttpOptions } from "node:url";

const domains = [
  "example.com",
  "EXAMPLE.COM",
  "example.com.",
  "bücher.example",
  "xn--bcher-kva.example",
  "ü",
  "",
  ".",
  "..",
  "a..b",
  "a b",
  "a_b.com",
  "-a.com",
  "a-.com",
  "example.com:80",
  "127.0.0.1",
  "[::1]",
  "exämple",
  "münchen.de",
  "😀.example",
  "xn--zz",
  "a".repeat(64) + ".com",
  "a.b-c.d",
  "1.2.3",
];
for (const domain of domains) console.log("ascii", JSON.stringify(domain), JSON.stringify(domainToASCII(domain)));
for (const domain of domains) console.log("unicode", JSON.stringify(domain), JSON.stringify(domainToUnicode(domain)));

// format(URL[, options]): the four options hide or widen the parts the
// href would print.
const url = new URL("https://user:pw@example.com:8080/a/b?x=1&y=2#frag");
console.log("format", format(url));
console.log("format auth false", format(url, { auth: false }));
console.log("format fragment false", format(url, { fragment: false }));
console.log("format search false", format(url, { search: false }));
console.log("format unicode true", format(new URL("https://bücher.example/ü?q=ü"), { unicode: true }));
console.log("format unicode false", format(new URL("https://bücher.example/ü?q=ü"), { unicode: false }));
console.log("format all", format(url, { auth: false, fragment: false, search: false, unicode: true }));
console.log("format empty options", format(url, {}));

// urlToHttpOptions: the hostname/path/port/auth mapping http.request
// consumes, including the file scheme and an IPv6 host.
const httpUrls = [
  "http://user:pw@example.com:8080/a/b?x=1#frag",
  "https://example.com/",
  "https://h:8443/p",
  "http://h:80/p?q=1",
  "http://u:p%20w@h:99/p",
  "http://[::1]:81/p?q#h",
  "file:///tmp/x",
  "ftp://h/p",
];
for (const href of httpUrls) console.log("http", href, JSON.stringify(urlToHttpOptions(new URL(href))));
