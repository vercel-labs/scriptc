"use strict";
class Node_ {
  constructor(v) { this.v = v; this.peers = []; }
}
exports.make = (v) => new Node_(v);
exports.link = (a, b) => { a.peers.push(b); };
exports.cbs = [];
exports.keep = (fn) => exports.cbs.push(fn);
exports.runAll = () => exports.cbs.map((f) => f()).length;
