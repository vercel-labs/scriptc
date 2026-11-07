// @requires-libnode
// A long session: a new Date, URL and URLSearchParams handed to a Node
// island on every request, most dropped by both sides at once. What either
// side keeps stays one object with the other side's, whatever is collected
// in between, and what the island remembered about a kept value by its
// identity is still there at the end.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

interface Request {
  at: Date;
  url: URL;
  query: URLSearchParams;
  attempt: number;
}

interface Kept {
  at: Date;
  url: URL;
}
const kept: Kept[] = [];
let checksum = 0;
for (let i = 0; i < 6_000; i++) {
  const request: Request = {
    at: new Date(1_700_000_000_000 + i),
    url: new URL("http://example.test/items/" + i + "?page=" + (i % 7)),
    query: new URLSearchParams("n=" + i),
    attempt: i,
  };
  checksum += lib.handle(request) as number;
  // The island moved the date on by a day and counted the page up.
  if (i % 1_500 === 0) console.log(i, request.at.getTime(), request.url.search, request.query.toString());
  // A few values outlive their request on each side.
  if (i % 600 === 0) {
    kept.push({ at: request.at, url: request.url });
    lib.note(request.at, request.url, i);
  }
  if (i % 1_500 === 0) lib.hold(request.at, request.url.searchParams);
}
console.log("checksum", checksum, lib.counts());

// What the program kept is still the object the island noted, and the
// island's notes are still attached to it.
for (let i = 0; i < kept.length; i++) {
  const pair = kept[i]!;
  pair.at.setTime(i);
  pair.url.hash = "#" + i;
}
console.log("noted", lib.noted(kept));
// What the island kept is still live with the program's writes.
console.log("held", lib.held());
