var util = require("util"),
  async_hooks = require("async_hooks"),
  decoder = require("string_decoder");

var textEncoder = new util.TextEncoder();
var requestStorage = new async_hooks.AsyncLocalStorage();

function encodeLength(text) {
  return textEncoder.encode(text).length;
}

function runWith(store, fn) {
  return requestStorage.run(store, function () {
    return requestStorage.getStore() + ":" + fn();
  });
}

var partial = new decoder.StringDecoder("utf8");
console.log(partial.write(Buffer.from([0xe2, 0x82])) + partial.end(Buffer.from([0xac])));

module.exports = { encodeLength, runWith };
