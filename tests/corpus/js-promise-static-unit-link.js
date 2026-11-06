// The generic Promise statics are the only dynamic surface here: the call
// itself must link the dyn-invoke unit (the capability's resolve and reject
// functions dispatch through it) and the dyn-async unit (the capability's
// value adopts as a dyn promise), so a build that gates those units on other
// dynamic features alone leaves the generic unit's references undefined. The
// surplus argument after the value runs in Node's order.
"use strict";

const log = [];

function C(executor) {
  log.push("construct");
  executor(function () {}, function () {});
}

const pending = Promise.resolve.call(C, 1, (log.push("extra"), "x"));
console.log("resolve: " + log.join(" | "));
