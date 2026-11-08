// JavaScript sources refuse the same writes when the program is built: a
// run-time fence could be swallowed by a `catch`, and the program would go
// on calling the built-in. Every write below is used through code that does
// not read the member from its object.
var savedPush = Array.prototype.push;

Array.prototype.push = function () {
  return savedPush.apply(this, arguments);
};
[1].push(2);
Map.prototype.get = function () {};
new Map().get(1);
Number.prototype.toFixed = function () {
  return "";
};
(1.5).toFixed(1);
Number.isInteger = function () {
  return true;
};
Number.isInteger(1.5);
delete Array.prototype.pop;
[1].pop();
Object.assign(Array.prototype, { shift() {} });
[1].shift();
// A copy of several members is one write for each: the first has no native
// use here, the others do.
Object.assign(String.prototype, { anchor() {}, padEnd() {}, [Symbol.iterator]() {} });
"a".padEnd(2);
for (const character of "ab") console.log(character);
// Every writer of a prototype object the dynamic tier holds as a value.
Object.defineProperties(Date.prototype, { getTime: { value: () => 42 } });
Object.defineProperty(Date.prototype, "getTime", { value: () => 42 });
Object.assign(Date.prototype, { getTime: () => 42 });
new Date(0).getTime();

// Inside a function, and inside a try block; the use is in another function.
function install() {
  Object.keys = function () {
    return [];
  };
}
try {
  JSON.stringify = function () {
    return "";
  };
} catch (error) {}
function report(value) {
  return Object.keys(value).length + JSON.stringify(value).length;
}

// A call through an untyped value reaches the built-in directly.
Set.prototype.add = function () {
  return this;
};
function remember(seen, value) {
  seen.add(value);
}

// The parts three corpus programs once held. Each wrote a member and used
// it natively, and matched Node only because of what the use happened to
// find. 8110-builtin-prototype-own-members: `slice` and `filter` read the
// constructor for the species of their result.
function Replacement() {}
Array.prototype.constructor = Replacement;
const replacedNames = Object.getOwnPropertyNames(Array.prototype);
console.log(replacedNames.slice(0, 2).join(","), replacedNames.filter((name) => name === "constructor").length);
// array-from-checked: the replaced iterator is called by name and read by a
// for…of over an array the source spells out, in functions that happened to
// run before the write.
function firstOf(items) {
  return items[Symbol.iterator]().next().value;
}
function pairs() {
  for (const [left, right] of [[1, 2]]) console.log(left, right);
}
const savedIterator = Array.prototype[Symbol.iterator];
Array.prototype[Symbol.iterator] = function () {
  return { next() { return { done: true }; } };
};
Array.prototype[Symbol.iterator] = savedIterator;
// collection-constructor-sparse-array-seed: the patching function reads the
// member it is about to redefine, and would read the redefined one if it ran
// twice.
function patchMap() {
  const original = Map.prototype.set;
  Object.defineProperty(Map.prototype, "set", {
    configurable: true,
    get() {
      return original;
    },
  });
}

// A definition may change the value of a member that is not configurable
// when it is writable; the feature test below was decided from the old one.
Object.defineProperty(Array.prototype, "length", { value: 5 });
if (Array.prototype.length) {
  Array.prototype.fill = function () {
    return this;
  };
}

install();
patchMap();
console.log(report({}), remember, firstOf, pairs);
