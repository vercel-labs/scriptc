"use strict";
// A request promise in the style of generated API clients: a Promise
// subclass whose constructor takes the work, not an executor, whose `then`
// starts the request the first time something waits for it, and which has
// methods of its own.
const log = [];
class ApiRequest extends Promise {
  constructor(work) {
    super((resolve) => {
      resolve(null);
    });
    this.work = work;
    this.started = undefined;
    this.retries = 0;
  }
  run() {
    if (this.started === undefined) {
      log.push("started");
      this.started = this.work();
    }
    return this.started;
  }
  asResponse() {
    return this.run().then((data) => ({ status: 200, body: JSON.stringify(data) }));
  }
  withResponse() {
    return this.run().then((data) => ({ data, response: { status: 200 } }));
  }
  get pending() {
    return this.started === undefined;
  }
  retry() {
    this.retries++;
    return this;
  }
  then(onFulfilled, onRejected) {
    return this.run().then(onFulfilled, onRejected);
  }
  catch(onRejected) {
    return this.run().catch(onRejected);
  }
  finally(onFinally) {
    return this.run().finally(onFinally);
  }
}
exports.create = (value, ms = 2) =>
  new ApiRequest(() => new Promise((resolve) => setTimeout(() => resolve(value), ms)));
exports.failing = (message) =>
  new ApiRequest(() => new Promise((_, reject) => setTimeout(() => reject(new Error(message)), 2)));
exports.log = () => log.splice(0).join(",");
exports.retries = (r) => r.retries;
exports.isRequest = (r) => r instanceof ApiRequest;
