"use strict";
let session;

exports.open = (s) => {
  session = s;
};
exports.read = () => `${session.started.getTime()} ${session.endpoint.href}`;
exports.advance = (ms, page) => {
  session.started.setTime(session.started.getTime() + ms);
  session.endpoint.searchParams.set("page", page);
};
exports.around = (callback) => {
  session.started.setMilliseconds(250);
  const answer = callback();
  return `${answer} then ${session.started.getTime()} ${session.endpoint.pathname}`;
};
exports.later = (ms, path) =>
  new Promise((resolve) =>
    setTimeout(() => {
      const before = exports.read();
      session.started.setTime(ms);
      session.endpoint.pathname = path;
      resolve(before);
    }, 5),
  );
exports.readLater = () => new Promise((resolve) => setTimeout(() => resolve(exports.read()), 20));
exports.settle = () => Promise.resolve().then(() => session);
exports.spin = (n) => {
  for (let i = 0; i < n; i++) {
    session.started.setTime(100000 + i);
    session.endpoint.searchParams.set("page", String(i));
  }
};
