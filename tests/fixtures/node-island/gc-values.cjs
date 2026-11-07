"use strict";
let requests = 0;
let pages = 0;
const notes = new WeakMap();
const held = [];

// A request reads and writes its values, as a client library does.
exports.handle = (request) => {
  const { at, url } = request;
  requests++;
  at.setTime(at.getTime() + 1);
  url.searchParams.set("q", "2");
};
exports.params = (params) => {
  pages += params.size;
};
// Remembered by identity only: the island keeps no reference.
exports.note = (at, url, i) => {
  notes.set(at, i);
  notes.set(url, i);
};
exports.noted = (kept) =>
  kept.filter(({ at, url }, i) => notes.get(at) === i && notes.get(url) === i && url.hash === "#kept")
    .length +
  "/" +
  kept.length +
  " " +
  kept.map(({ at }) => at.getTime()).join(",");
exports.hold = (at, url) => held.push([at, url]);
exports.counts = () =>
  `${requests} ${pages} ${held.map(([at, url]) => `${at.getTime()}${url.search}`).join(",")}`;
