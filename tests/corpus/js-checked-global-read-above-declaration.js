// A JavaScript module-scope object literal that holds an existing
// checked-dynamic value keeps that storage, and the function declared above
// the declaration reads the same object it stored.
function readHidden() {
  return internals.hidden;
}
function setHidden(next) {
  internals.hidden = next;
}
var frozen = Object.freeze({ n: 1 });
var internals = {
  hidden: frozen,
  provider: null,
  count: 0
};
console.log("identity", readHidden() === frozen);
setHidden({ n: 2 });
console.log("replaced", readHidden().n, internals.count);
