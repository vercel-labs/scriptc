// `Map.prototype`, `Set.prototype`, `WeakMap.prototype` and `WeakSet.prototype`
// are one object each: the value a bare read answers, the object a member is
// read through, and the prototype of an instance. A property written through
// an alias is there when the member is read through the class again.
const mapProto = Map.prototype;
mapProto.added = 7;
console.log(Map.prototype.added);
Set.prototype.extra = function () {
  return "extra";
};
const setProto = Object.getPrototypeOf(new Set());
console.log(typeof Set.prototype.extra, Set.prototype.extra(), typeof setProto.extra);
console.log(Map.prototype.get === mapProto.get, Set.prototype.has === setProto.has);
const weakMapProto = WeakMap.prototype;
const weakSetProto = WeakSet.prototype;
console.log(WeakMap.prototype.has === weakMapProto.has, WeakSet.prototype.has === weakSetProto.has);
console.log(
  Object.getPrototypeOf(new Map()) === Map.prototype,
  Object.getPrototypeOf(new Set()) === Set.prototype,
  Object.getPrototypeOf(new WeakMap()) === WeakMap.prototype,
  Object.getPrototypeOf(new WeakSet()) === WeakSet.prototype,
);
console.log(typeof Map.prototype.get, typeof Set.prototype.add, typeof WeakMap.prototype.has);
console.log(Map.prototype.get.call(new Map([[1, "one"]]), 1), Set.prototype.has.call(new Set([2]), 2));
console.log(Map.prototype.get.name, Set.prototype.add.length, Map.prototype.constructor === Map);
console.log(Object.prototype.toString.call(Map.prototype), Map.prototype[Symbol.toStringTag]);
console.log(Object.getOwnPropertyNames(Map.prototype).sort().join(","));
console.log(Object.getPrototypeOf(Map.prototype) === Object.prototype);
try {
  Map.prototype.get.call({}, 1);
} catch (e) {
  console.log(e.constructor.name);
}
