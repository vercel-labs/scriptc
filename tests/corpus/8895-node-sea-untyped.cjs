// node:sea and process.getBuiltinModule from untyped code: the module
// object's keys, its functions' names and lengths, Node's argument checks
// ahead of the not-an-application error, and which ids the loader knows.
const sea = require("node:sea");
console.log(Object.keys(sea).join(","), typeof sea);
// The module object a computed id answers, for reflection by name.
const load = process.getBuiltinModule;
const object = load(["node", "sea"].join(":"));
for (const name of Object.keys(object)) console.log(name, typeof object[name], object[name].name, object[name].length);
console.log(sea.isSea(), object.isSea(1, 2), object.missing, object.isSea === object.isSea);

function report(label, read) {
  try {
    console.log(label, "returned", read());
  } catch (error) {
    console.log(label, error.name, error.code, error.message);
  }
}
report("getAsset()", () => sea.getAsset());
report("getAsset(1)", () => sea.getAsset(1));
report("getAsset(key, 7)", () => sea.getAsset("a", 7));
report("getAsset(1, 7)", () => sea.getAsset(1, 7));
report("getAsset(key)", () => sea.getAsset("a"));
report("getAsset(key, enc)", () => sea.getAsset("a", "utf8"));
report("getRawAsset()", () => sea.getRawAsset());
report("getRawAsset(key)", () => sea.getRawAsset("a"));
report("getAssetAsBlob({})", () => sea.getAssetAsBlob({}));
report("getAssetAsBlob(key)", () => sea.getAssetAsBlob("a"));
report("getAssetKeys()", () => sea.getAssetKeys());
const read = sea.getAsset;
report("stored getAsset", () => read("a"));

console.log(load("node:sea") === object, load("sea"));
const ids = ["sea", "node:sea", "node:node:sea", "SEA", "node:Sea", "sea/", "", "node:", "missing", "node:missing", "./sea"];
for (const id of ids) {
  const value = load(id);
  console.log(JSON.stringify(id), value === undefined ? "undefined" : typeof value, value === object);
}
for (const id of [undefined, null, 7, {}, ["node:sea"], true]) {
  try {
    load(id);
    console.log("loaded");
  } catch (error) {
    console.log(error.name, error.code, error.message);
  }
}
report("loaded getAsset(1)", () => object.getAsset(1));
report("loaded getAsset(key)", () => object.getAsset("a"));
console.log(object.isSea(), Object.keys(object).length, "isSea" in object, "missing" in object);
