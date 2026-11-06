// WeakMap.prototype and WeakSet.prototype are ordinary objects whose members
// brand-check their receiver: the same machinery as Map.prototype, without
// size or iteration.
const weakMapPrototype = WeakMap.prototype;
const weakSetPrototype = WeakSet.prototype;
const refused = (run) => {
  try {
    run();
    return "no error";
  } catch (error) {
    return error.name + " " + (error instanceof TypeError);
  }
};
console.log("weakmap names", Object.getOwnPropertyNames(weakMapPrototype).join(","));
console.log("weakset names", Object.getOwnPropertyNames(weakSetPrototype).join(","));
console.log("weakmap identity", Object.getPrototypeOf(new WeakMap()) === weakMapPrototype);
console.log("weakset identity", Object.getPrototypeOf(new WeakSet()) === weakSetPrototype);
console.log("weakmap tag", weakMapPrototype[Symbol.toStringTag]);
console.log("weakset tag", weakSetPrototype[Symbol.toStringTag]);
console.log("weakmap size", "size" in weakMapPrototype, typeof weakMapPrototype.size);
console.log("weakmap iterator", Symbol.iterator in weakMapPrototype);
console.log("weakmap constructor", weakMapPrototype.constructor === WeakMap);
console.log("weakset constructor", weakSetPrototype.constructor === WeakSet);

// An instance's member value is the prototype's function object.
console.log(
  "weakmap method identity",
  weakMapPrototype.get === new WeakMap().get,
  weakMapPrototype.set === new WeakMap().set,
  weakMapPrototype.has === new WeakMap().has,
);
console.log(
  "weakset method identity",
  weakSetPrototype.add === new WeakSet().add,
  weakSetPrototype.has === new WeakSet().has,
);

const key = {};
const weakMap = new WeakMap();
weakMap.set(key, 41);
const weakSet = new WeakSet();
weakSet.add(key);

// Every member throws through the prototype object, and runs through a real
// receiver.
const weakMapMember = (name, member) => {
  const throughPrototype = refused(() => member.call(weakMapPrototype, key));
  const throughObject = refused(() => member.call({}, key, 1));
  console.log("weakmap", name, throughPrototype, throughObject);
};
weakMapMember("delete", weakMapPrototype.delete);
weakMapMember("get", weakMapPrototype.get);
weakMapMember("has", weakMapPrototype.has);
weakMapMember("set", weakMapPrototype.set);
const weakSetMember = (name, member) => {
  const throughPrototype = refused(() => member.call(weakSetPrototype, key));
  const throughArray = refused(() => member.call([], key));
  console.log("weakset", name, throughPrototype, throughArray);
};
weakSetMember("add", weakSetPrototype.add);
weakSetMember("delete", weakSetPrototype.delete);
weakSetMember("has", weakSetPrototype.has);
console.log("weakmap get call", weakMapPrototype.get.call(weakMap, key));
console.log("weakmap has call", weakMapPrototype.has.call(weakMap, key));
console.log("weakset has call", weakSetPrototype.has.call(weakSet, key));
console.log("weakmap delete call", weakMapPrototype.delete.call(weakMap, key), weakMap.has(key));
console.log("weakset delete call", weakSetPrototype.delete.call(weakSet, key), weakSet.has(key));

// A cross-class receiver is not a WeakMap.
console.log("weakmap on map", refused(() => weakMapPrototype.get.call(new Map(), key)));
console.log("weakset on set", refused(() => weakSetPrototype.has.call(new Set(), key)));
console.log("tag text", Object.prototype.toString.call(new WeakMap()));
