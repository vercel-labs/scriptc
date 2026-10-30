"use strict";
// Getters and setters on JavaScript classes. An accessor whose name no
// field uses lives on the prototype beside the fields; an accessor that
// shares a field's name decides what an assignment does. Both behave as in
// Node, for direct use and for instances passed to untyped code.

class LazyPath {
  constructor(parent, value, path, key) {
    this._cachedPath = [];
    this.parent = parent;
    this.data = value;
    this._path = path;
    this._key = key;
  }
  get path() {
    if (!this._cachedPath.length) {
      if (Array.isArray(this._key)) this._cachedPath.push(...this._path, ...this._key);
      else this._cachedPath.push(...this._path, this._key);
    }
    return this._cachedPath;
  }
}

class Temperature {
  constructor(celsius) {
    this.celsius = celsius;
  }
  get fahrenheit() {
    return this.celsius * 1.8 + 32;
  }
  set fahrenheit(value) {
    this.celsius = (value - 32) / 1.8;
  }
}

class Labeled extends Temperature {
  constructor(celsius, label) {
    super(celsius);
    this.label = label;
  }
  get description() {
    return `${this.label}: ${this.celsius.toFixed(1)}C`;
  }
}

/** @param {any} target @param {string} key @param {unknown} value */
function put(target, key, value) {
  target[key] = value;
}

/** @param {any} value */
function describe(value) {
  const parts = [];
  for (const key in value) parts.push(key);
  return `${Object.keys(value).join(",")} | ${parts.join(",")} | ${JSON.stringify(value)}`;
}

/** @param {any} value @param {string} key */
function probe(value, key) {
  return `${key}: in=${key in value} own=${Object.prototype.hasOwnProperty.call(value, key)} value=${JSON.stringify(value[key])}`;
}

const root = { common: true };
const paths = [];
for (let i = 0; i < 3; i++) paths.push(new LazyPath(root, { n: i }, ["items"], i));
paths.push(new LazyPath(root, null, ["a"], ["b", "c"]));
for (const item of paths) console.log(item.path.join("."), item.data && item.data.n, item.parent === root);
console.log(describe(paths[0]));
console.log(probe(paths[1], "path"), probe(paths[1], "_key"));
put(paths[2], "extra", 1);
console.log(describe(paths[2]), paths[2].path.length);

const t = new Temperature(100);
console.log(t.fahrenheit, describe(t));
t.fahrenheit = 32;
console.log(t.celsius, t.fahrenheit);
put(t, "fahrenheit", 212);
console.log(t.celsius, probe(t, "fahrenheit"), probe(t, "celsius"));
put(t, "note", "added");
console.log(describe(t));

const l = new Labeled(20, "room");
console.log(l.description, l.fahrenheit, describe(l));
l.fahrenheit = 50;
console.log(l.description, probe(l, "description"));
