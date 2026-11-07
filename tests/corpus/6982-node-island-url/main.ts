// @requires-libnode
// A native URL in a Node island is a URL there: a class of the island that
// takes a URL in its constructor (a proxy agent) reads its parts, Node's
// own URL receivers accept it, the same URL crosses as the same object, and
// it comes back as the program's own URL.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

interface Target {
  label: string;
  url: URL;
}

const proxy = new URL("http://user:pw@proxy.example.test:8080/base/path?x=1&y=2#frag");
const other = new URL("http://user:pw@proxy.example.test:8080/base/path?x=1&y=2#frag");

for (const line of lib.describe(proxy)) console.log(line);

// A constructor of the island given the URL (and the same class given text).
const agent = new lib.Agent(proxy);
console.log("agent", agent.describe());
console.log("agent from text", new lib.Agent("https://text.example.test/").describe());
console.log("agent keeps the object", lib.agentUrlIs(agent, proxy), lib.agentUrlIs(agent, other));

// Node's own receivers.
console.log("http options", lib.httpOptions(new URL("http://user:pw@example.test:8080/p?q=1")));
console.log("file path", lib.filePath(new URL("file:///tmp/a%20b.txt")));
console.log("fetch request", lib.requestUrl(new URL("http://example.test/r?s=1")));

// One island object per native URL.
console.log("keep", lib.keep(proxy), lib.keep(proxy), lib.keep(other), lib.keep(proxy));
console.log("weak", lib.remember(proxy, "first"), lib.remember(proxy, "second"), lib.remember(other, "x"));
const target: Target = { label: "t", url: proxy };
console.log("in a record", lib.sameMember(target, "url", proxy), lib.hrefOf(target));

// Coming back: the program's own URL.
const back: URL = lib.back(proxy);
console.log("back", back === proxy, back === other, back.host);
const kept: URL = lib.kept();
console.log("kept", kept === proxy);
const wrapped = lib.wrap(other);
const inner: URL = wrapped.url;
console.log("wrapped", inner === other, inner.pathname);

// Kinds of URL.
const loose: unknown = new URL("http://example.test/loose");
console.log("unknown", lib.href(loose));
for (const text of [
  "http://[::1]:8080/x",
  "http://example.test/\u00e9?q=\u00e9#\u00e9",
  "mailto:a@example.test",
  "file:///C:/x/y",
  "custom://host/path?x#y",
  "http://EXAMPLE.test:80/a/../b",
]) {
  const url = new URL(text);
  console.log("kind", lib.href(url), lib.href(url) === url.href);
}
