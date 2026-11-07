"use strict";
exports.describe = (value) =>
  `${Object.prototype.toString.call(value)} ${value instanceof Date} ${value.getTime()}`;
exports.tag = (date) => {
  date.tagged = 1;
};
exports.tagged = (date) => date.tagged;
