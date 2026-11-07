// @requires-libnode
// A native URL and its object in a Node island are one URL: a setter on
// either side shows on the other, for href and every part, and the URL's
// searchParams is live on both sides whichever side writes through it.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

function fresh(): URL {
  return new URL("http://user:pw@example.test:8080/a/b?x=1&y=2#frag");
}

// The island writes, the program reads.
const writes: [string, string][] = [
  ["href", "http://other.test/p?q=1#h"],
  ["protocol", "https:"],
  ["username", "alice"],
  ["password", "secret"],
  ["host", "c.test:81"],
  ["hostname", "d.test"],
  ["port", "82"],
  ["pathname", "/p/q r"],
  ["search", "?s=1&t=\u00e9"],
  ["hash", "#h2"],
];
for (const [part, value] of writes) {
  const u = fresh();
  const answer: string = lib.set(u, part, value);
  console.log("island", part, answer, u.href, u.href === lib.href(u));
}
for (const [method, a, b] of [
  ["append", "k", "v w"],
  ["set", "x", "9"],
  ["delete", "x", ""],
  ["sort", "", ""],
]) {
  const u = fresh();
  lib.params(u, method, a, b);
  console.log("island searchParams", method, u.href, u.search, u.searchParams.toString(), u.searchParams.get("x"));
}

// The program writes, the island reads: its object from before the write
// (held) and the URL handed over again.
function native(label: string, write: (u: URL) => void): void {
  const u = fresh();
  lib.hold(u);
  write(u);
  console.log("native", label, u.href, lib.heldHref() === u.href, lib.href(u) === u.href, lib.heldSearch());
}
native("href", (u) => {
  u.href = "http://other.test/p?q=1#h";
});
native("protocol", (u) => {
  u.protocol = "https:";
});
native("username", (u) => {
  u.username = "alice";
});
native("password", (u) => {
  u.password = "secret";
});
native("host", (u) => {
  u.host = "c.test:81";
});
native("hostname", (u) => {
  u.hostname = "d.test";
});
native("port", (u) => {
  u.port = "82";
});
native("pathname", (u) => {
  u.pathname = "/p/q r";
});
native("search", (u) => {
  u.search = "?s=1";
});
native("hash", (u) => {
  u.hash = "#h2";
});
native("searchParams.append", (u) => u.searchParams.append("k", "v w"));
native("searchParams.set", (u) => u.searchParams.set("x", "9"));
native("searchParams.delete", (u) => u.searchParams.delete("x"));
native("searchParams.sort", (u) => u.searchParams.sort());

// The island's searchParams object, held from before a native write.
const live = fresh();
lib.holdParams(live);
live.searchParams.append("n", "1");
console.log("held searchParams", lib.heldParams());
live.search = "?replaced=yes";
console.log("held searchParams", lib.heldParams(), live.searchParams.get("replaced"));
lib.appendHeld("i", "2");
console.log("after the island appended", live.href, live.searchParams.get("i"));
