// Date, URL and URLSearchParams twins are collected with their requests
// (node-island-gc.test.ts): each iteration makes a Date and a URL, hands
// them to the island in a record, and drops them; every fourth also hands
// over the URL's searchParams, which holds its URL natively. Ten pairs stay
// with the program and four with the island whatever the count, so what a
// run holds at its end does not grow with it, and what the island
// remembered about the program's ten by their identity is still there.
// Usage: gc-values <n>
import { requireModule } from "@scriptc/node";

interface Request {
  at: Date;
  url: URL;
  attempt: number;
}

const lib = requireModule("./gc-values.cjs");
const n = Number(process.argv[2] ?? "1000");
const kept: Request[] = [];
for (let i = 0; i < n; i++) {
  const request: Request = {
    at: new Date(i),
    url: new URL("http://example.test/" + i + "?q=1"),
    attempt: i,
  };
  lib.handle(request);
  if (i % 4 === 0) lib.params(request.url.searchParams);
  if (i < 10) {
    kept.push(request);
    lib.note(request.at, request.url, i);
  } else if (i < 14) {
    lib.hold(request.at, request.url);
  }
}
// The program's ten are still the objects the island noted.
for (const request of kept) {
  request.at.setTime(request.at.getTime() + 1000);
  request.url.hash = "#kept";
}
console.log(lib.counts(), lib.noted(kept));
