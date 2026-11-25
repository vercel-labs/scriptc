// The popup store's shape: a Set of layer records, built from an untyped
// array of the same records and then keyed by them. The dynamic elements
// adopt the record type as a live capsule, so `has` and `delete` see the
// very objects the program holds.
function makeLayer(parent) {
  return { parent, order: 0, keep: null, el: null };
}
const own = makeLayer(null);
const parentLayer = makeLayer(null);
own.parent = parentLayer;
/** @returns {unknown[]} */
function activeLayers() {
  return [own.parent, own];
}
const beneath = new Set(activeLayers());
console.log("built", beneath.size);
for (let up = own.parent; up; up = up.parent) {
  beneath.add(up);
}
console.log("has-parent", beneath.has(own.parent));
beneath.delete(own.parent);
console.log("after-delete", beneath.size, beneath.has(own.parent));
