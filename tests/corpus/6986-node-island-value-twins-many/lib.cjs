"use strict";
let requests = 0;
const notes = new WeakMap();
const held = [];

// A request's values are read and written, then dropped.
exports.handle = (request) => {
  requests++;
  const { at, url, query } = request;
  at.setTime(at.getTime() + 86_400_000);
  url.searchParams.set("page", String(Number(url.searchParams.get("page")) + 1));
  query.append("seen", "1");
  return at.getUTCDay() + url.pathname.length + query.size;
};
// Remembered by identity only: the island keeps no reference.
exports.note = (at, url, i) => {
  notes.set(at, `date ${i}`);
  notes.set(url, `url ${i}`);
  at.noted = i;
};
exports.noted = (kept) =>
  kept
    .map(({ at, url }) => `${notes.get(at)}/${at.noted}/${at.getTime()} ${notes.get(url)}/${url.hash}`)
    .join("; ");
exports.hold = (at, params) => held.push([at, params]);
exports.held = () => held.map(([at, params]) => `${at.getTime()} ${params}`).join("; ");
exports.counts = () => `${requests} requests, ${held.length} held`;
