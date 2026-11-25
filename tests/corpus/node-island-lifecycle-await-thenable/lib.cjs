"use strict";
exports.thenable = (v) => ({ then(resolve) { resolve(v); } });
exports.rejecting = (m) => ({ then(_, reject) { reject(new Error(m)); } });
exports.lazy = (v) => ({ then(resolve) { setTimeout(() => resolve(v), 2); } });
class Query {
  constructor(v) { this.v = v; }
  then(resolve, reject) { return Promise.resolve(this.v * 2).then(resolve, reject); }
}
exports.query = (v) => new Query(v);
exports.plain = () => ({ value: 1 });
exports.notCallable = () => ({ then: 7 });
exports.throwingGetter = () => ({
  get then() {
    throw new Error("then getter threw");
  },
});
