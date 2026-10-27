// Object.prototype as a value: destructured and aliased methods, the
// prototype's own constructor and members, `{}.valueOf`, and the
// `Object.prototype.toString.call(x)` tag idiom (acorn, ini, qs,
// safe-stable-stringify, rfdc).
const { hasOwnProperty, propertyIsEnumerable } = Object.prototype;
const toStr = Object.prototype.toString;
const has = Object.prototype.hasOwnProperty;
const o = { a: 1 };
console.log(hasOwnProperty.call(o, "a"), hasOwnProperty.call(o, "b"), has.call(o, "a"), propertyIsEnumerable.call(o, "a"));
console.log(toStr.call([]), toStr.call(null), toStr.call(undefined), toStr.call(new Date(0)), toStr.call(/x/), toStr.call(1), toStr.call("s"), toStr.call(true), toStr.call(o), toStr.call(new Error("e")), toStr.call(new RangeError("r")), toStr.call(() => 1), toStr.call(new Map()));
console.log({}.valueOf === Object.prototype.valueOf, ({}).toString === toStr, typeof Object.prototype.toString, Object.prototype.constructor === Object);
console.log(hasOwnProperty === Object.prototype.hasOwnProperty, o.hasOwnProperty === hasOwnProperty, [].hasOwnProperty === has);
function kind(value) {
  switch (toStr.call(value)) {
    case "[object Date]": return "date:" + value.getTime();
    case "[object Array]": return "array:" + value.length;
    case "[object RegExp]": return "regexp:" + value.source;
    case "[object Error]": return "error:" + value.message;
    case "[object Object]": return "object:" + Object.keys(value).join(",");
    default: return "other";
  }
}
console.log([new Date(5), [1, 2], /ab/, new Error("boom"), { p: 1, q: 2 }, 3].map(kind).join(" "));
const config = JSON.parse('{"name":"app","db":{"host":"h"}}');
for (const key in config) if (has.call(config, key)) console.log(key, typeof config[key], toStr.call(config[key]));
