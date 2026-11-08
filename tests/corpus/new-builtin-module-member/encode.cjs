var async_hooks = require("async_hooks");

var requestStorage = new async_hooks.AsyncLocalStorage();

function runWith(store, fn) {
  return requestStorage.run(store, function () {
    return requestStorage.getStore() + ":" + fn();
  });
}

module.exports = { runWith };
