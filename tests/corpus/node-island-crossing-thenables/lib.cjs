"use strict";
exports.resolves = (v) => ({ then(resolve) { resolve(v); } });
exports.rejects = (m) => ({ then(_, reject) { reject(new Error(m)); } });
exports.throws = (m) => ({ then() { throw new Error(m); } });
exports.resolvesThenThrows = (v) => ({ then(resolve) { resolve(v); throw new Error("ignored"); } });
exports.never = () => ({ then() {} });
exports.later = (v) => ({ then(resolve) { setTimeout(() => resolve(v), 2); } });
exports.getterThrows = (m) => Object.defineProperty({}, "then", { get() { throw new Error(m); } });
exports.notCallable = () => ({ then: 5, tag: "plain" });
exports.chained = (v) => ({ then(resolve) { resolve(exports.resolves(v)); } });
exports.promised = (v) => ({ then(resolve) { resolve(Promise.resolve(v)); } });
exports.counting = () => {
  const calls = [];
  return { calls, then(resolve, reject) { calls.push(`${typeof resolve}/${typeof reject}/${this === undefined ? "none" : typeof this.then}`); resolve(calls.length); } };
};
class Query {
  constructor(v) { this.v = v; }
  then(resolve, reject) { return Promise.resolve(this.v * 2).then(resolve, reject); }
}
exports.query = (v) => new Query(v);
