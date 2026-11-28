// A Proxy settings value answers like the object spread: one ownKeys call,
// then for each key in order one getOwnPropertyDescriptor call and, when the
// key is enumerable, one get call.
const cluster = require("cluster");

const log = [];
const target = { a: 1, b: 2 };
Object.defineProperty(target, "c", { value: 3, enumerable: false, configurable: true });
const proxy = new Proxy(target, {
  ownKeys(t) {
    log.push("ownKeys");
    return ["a", "b", "c"];
  },
  getOwnPropertyDescriptor(t, key) {
    log.push("desc " + key);
    const descriptor = Object.create(null);
    descriptor.value = t[key];
    descriptor.enumerable = key !== "c";
    descriptor.configurable = true;
    descriptor.writable = true;
    return descriptor;
  },
  get(t, key) {
    log.push("get " + key);
    return t[key];
  },
});
cluster.on("setup", (settings) => console.log("setup", settings.a, settings.b, settings.c));
cluster.setupPrimary(proxy);
console.log(log.join(" | "));
