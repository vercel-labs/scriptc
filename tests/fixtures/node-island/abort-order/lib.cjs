"use strict";
const { getEventListeners } = require("node:events");

exports.listen = (signal, label) => {
  signal.addEventListener("abort", () => console.log(label));
  return getEventListeners(signal, "abort").length;
};
exports.count = (signal) => getEventListeners(signal, "abort").length;
