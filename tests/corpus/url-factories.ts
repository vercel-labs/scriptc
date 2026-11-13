// URL.canParse, URL.parse, url.toString, url.toJSON and URL.revokeObjectURL:
// the WHATWG parser's factory answers, the serialization both methods
// return, and the argument validation Node applies.
import { URL } from "node:url";

const fail = (label: string, fn: () => unknown): void => {
  try {
    const value = fn();
    console.log(label, "ok", typeof value, JSON.stringify(value));
  } catch (error) {
    const e = error as Error & { code?: string };
    console.log(label, "throw", e.code, e.name, e.message);
  }
};

const inputs: [string, string | undefined][] = [
  ["https://a/b?c#d", undefined], ["/x", "https://a/b/c"], ["x", "https://a/b/c/"],
  ["https://a", undefined], ["not a url", undefined], ["", "https://a/b"],
  ["//h/p", "https://a/b"], ["?", "https://a/b"], ["#x", "https://a/b"],
  ["  https://a/b  ", undefined], ["HTTPS://A/B", undefined],
  ["https://user:pass@a:8080/p", undefined], ["file:///a/b", undefined],
  ["mailto:a@b", undefined], ["data:text/plain,hi", undefined],
  ["https://bücher.example/ü?ü=ü#ü", undefined], ["https://a/%zz", undefined],
  ["https://a:99999/", undefined], ["https://a:0/", undefined],
];
for (const [input, base] of inputs) {
  const label = `${JSON.stringify(input)} ${JSON.stringify(base)}`;
  console.log(`canParse ${label}`, URL.canParse(input, base));
  fail(`parse ${label}`, () => URL.parse(input, base)?.href);
}

fail("parse no base", () => URL.parse("/x")?.href);
fail("parse invalid base", () => URL.parse("/x", "not a url"));
fail("parse invalid input", () => URL.parse("not a url"));
fail("canParse invalid base", () => URL.canParse("/x", "not a url"));

// toString and toJSON both answer the serialized href.
for (const href of [
  "https://user:pa%20ss@example.com:8080/a/b?x=1&y=2#h",
  "https://example.com",
  "file:///a/b",
  "https://bücher.example/ü?ü=ü#ü",
  "https://a/%41",
  "mailto:a@b",
  "https://a",
  "http://a:80/x",
  "https://a:443/x",
  "ws://a:80/x",
]) {
  const url = new URL(href);
  console.log(`toString ${href}`, url.toString(), url.toJSON(), url.href);
  console.log(`template ${href}`, `${url}`);
  console.log(`json ${href}`, JSON.stringify(url));
}

// Revoking an id answers undefined whatever the id is.
fail("revoke object", () => URL.revokeObjectURL("blob:https://a/b"));
fail("revoke empty", () => URL.revokeObjectURL(""));
