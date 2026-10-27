// Constructor-function streams that override stream methods, and a plain
// JavaScript sink.
import { Readable, Writable } from "node:stream";
import util from "node:util";

/** A Readable whose pause, resume and on record their calls before
 * running Readable's own. */
function Recording() {
  Readable.call(this, { read() {} });
  this.calls = [];
}
util.inherits(Recording, Readable);
for (const name of ["pause", "resume", "on"]) {
  Recording.prototype[name] = function (...args) {
    this.calls.push(name);
    return Readable.prototype[name].apply(this, args);
  };
}

/** @returns {any} */
export function recordingSource() {
  return new Recording();
}

/** A Writable without overrides, piped into natively. */
function Collector() {
  Writable.call(this);
  this.chunks = [];
}
util.inherits(Collector, Writable);
Collector.prototype._write = function (chunk, _encoding, done) {
  this.chunks.push(String(chunk));
  done();
};

/** @returns {any} */
export function collector() {
  return new Collector();
}
