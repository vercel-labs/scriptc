// Computed stores with string keys into ordinary objects: adds in order,
// replacements, array-index names, accessor targets and synced error fields.
function copy(source, skip) {
  const out = {};
  let key;
  for (key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key) && key !== skip) out[key] = source[key];
  }
  return out;
}
const a = copy({ b: 1, a: 2, 10: "ten", 2: "two", c: 3 }, "c");
console.log(JSON.stringify(a), Object.keys(a).join(","));
const b = copy({ x: 1, y: 2 }, "x");
const c = copy({ y: 5, z: 6 }, "none");
console.log(JSON.stringify(b), JSON.stringify(c));

const target = {};
const names = ["first", "second", "first", "third"];
for (let i = 0; i < names.length; i++) target[names[i]] = i;
console.log(JSON.stringify(target));

const logged = [];
const accessor = {
  /** @param {number} v */
  set value(v) {
    logged.push(v);
  },
};
const property = "value";
accessor[property] = 42;
console.log(logged.join(","), Object.keys(accessor).join(","));

const error = new Error("original");
const field = "message";
error[field] = "changed";
console.log(error.message);
