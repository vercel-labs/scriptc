"use strict";
const util = require("node:util");
const v8 = require("node:v8");

let last;
const weak = new WeakMap();

exports.describe = (d) => {
  const clone = structuredClone(d);
  return [
    `tag ${Object.prototype.toString.call(d)} ${typeof d}`,
    `instanceof ${d instanceof Date} ${Object.getPrototypeOf(d) === Date.prototype} ${d.constructor === Date}`,
    `types ${util.types.isDate(d)} ${Reflect.ownKeys(d).length} ${Object.isExtensible(d)}`,
    `brand ${Date.prototype.getTime.call(d)} ${Date.prototype.toISOString.call(d)}`,
    `inspect ${util.inspect(d)} ${util.inspect({ d })}`,
    `json ${JSON.stringify(d)} ${JSON.stringify({ d })}`,
    `value ${+d} ${d.valueOf()} ${d - new Date(0)} ${d.getUTCFullYear()}`,
    `clone ${clone instanceof Date} ${clone === d} ${clone.getTime()}`,
    `serialize ${v8.deserialize(v8.serialize(d)).toISOString()}`,
    `equal ${util.isDeepStrictEqual(d, new Date(1700000000000))} ${util.isDeepStrictEqual(d, new Date(0))}`,
    `intl ${new Intl.DateTimeFormat("en-US", { timeZone: "UTC", dateStyle: "medium" }).format(d)}`,
  ];
};

exports.keep = (d) => {
  const same = last === d;
  last = d;
  return same;
};
exports.kept = () => last;
exports.remember = (d, label) => {
  const before = weak.get(d);
  weak.set(d, label);
  return String(before);
};
exports.sameMember = (record, key, d) => record[key] === d;
exports.sameEntry = (map, key, d) => map.get(key) === d;
exports.format = (event) => `${event.name} at ${event.when.toISOString()}`;
exports.tag = (d, value) => {
  const before = d.tagged;
  d.tagged = value;
  return String(before);
};
exports.back = (d) => d;
exports.wrap = (d) => ({ when: d, list: [d, d] });
exports.iso = (d) => `${Object.prototype.toString.call(d)} ${d.toISOString()}`;
exports.text = (d) => String(d);
exports.time = (d) => d.getTime();
