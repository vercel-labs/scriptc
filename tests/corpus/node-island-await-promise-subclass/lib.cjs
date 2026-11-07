"use strict";
// A request promise in the style of generated API clients: a Promise
// subclass whose constructor takes the work to do, not an executor, and
// whose `then` starts the work the first time something waits for it.
const log = [];
class Request extends Promise {
  constructor(work) {
    super((resolve) => {
      // Never settled here: the result comes from `then`.
      resolve(null);
    });
    this.work = work;
    this.started = undefined;
  }
  run() {
    if (this.started === undefined) {
      log.push("started");
      this.started = this.work();
    }
    return this.started;
  }
  then(onFulfilled, onRejected) {
    return this.run().then(onFulfilled, onRejected);
  }
  catch(onRejected) {
    return this.run().catch(onRejected);
  }
}
exports.request = (value, ms) =>
  new Request(() => new Promise((resolve) => setTimeout(() => resolve(value), ms)));
exports.failing = (message, ms) =>
  new Request(() => new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)));
exports.log = () => log.splice(0).join(",");
exports.awaitIt = async (r) => await r;
// A subclass that keeps the executor form: awaited through its `then` too.
class Tagged extends Promise {
  then(onFulfilled, onRejected) {
    log.push("tagged then");
    return super.then(onFulfilled, onRejected);
  }
}
exports.tagged = (value) => Tagged.resolve(value);
exports.plain = (value) => Promise.resolve(value);
