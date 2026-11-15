"use strict";
// An SDK-style request promise: a Promise subclass with members of its own.
class Request extends Promise {
  static to(url, value, fails) {
    const r = new Request((resolve, reject) => setTimeout(() => (fails ? reject(new Error(`failed ${url}`)) : resolve(value)), 2));
    r.url = url;
    r.attempts = 1;
    return r;
  }
  get label() {
    return `request ${this.url}`;
  }
  describe() {
    return `${this.label} x${this.attempts}`;
  }
  withResponse() {
    return this.then((data) => ({ data, status: 200 }));
  }
  retry() {
    this.attempts++;
    return this;
  }
}
exports.Request = Request;
exports.request = (url, value) => Request.to(url, value, false);
exports.failing = (url) => Request.to(url, undefined, true);
exports.attempts = (r) => r.attempts;
exports.isRequest = (r) => r instanceof Request;
