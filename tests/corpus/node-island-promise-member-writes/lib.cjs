"use strict";
// An SDK-style request promise: a Promise subclass with members of its own.
class Request extends Promise {
  static to(url, value) {
    const r = new Request((resolve) => setTimeout(() => resolve(value), 2));
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
  retry() {
    this.attempts++;
    return this;
  }
}
exports.request = (url, value) => Request.to(url, value);
exports.read = (r, key) => r[key];
exports.has = (r, key) => Object.hasOwn(r, key);
