// JavaScript sources refuse the same writes at build time: a deferred
// run-time fence could be swallowed by a `catch`, and the program would go
// on calling the built-in.
var savedPush = Array.prototype.push;

Array.prototype.push = function () {
  return savedPush.apply(this, arguments);
};
Map.prototype.get = function () {};
Number.prototype.toFixed = function () {
  return "";
};
Number.isInteger = function () {
  return true;
};
delete Array.prototype.pop;
delete String.prototype.trim;
Object.assign(Array.prototype, { shift() {} });
Array.prototype.toJSON = function () {
  return "array";
};
// Every writer of a prototype object the dynamic tier holds as a value.
Object.defineProperties(Date.prototype, { getTime: { value: () => 42 } });
Object.defineProperty(Date.prototype, "getTime", { value: () => 42 });
Object.assign(Date.prototype, { getTime: () => 42 });
Object.defineProperty(Promise, "resolve", { value: 1 });

// Inside a function, and inside a try block.
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

// A guard that does not prove the write unreachable.
if (process.argv.length > 2) {
  Math.round = function () {
    return 0;
  };
}
// A guarded polyfill whose arm declares a binding the rest of the file
// sees: the arm has to lower, so the write in it is refused.
if (!String.prototype.at) {
  var atHelper = function () {};
  String.prototype.at = atHelper;
}
// A guard that tests the member the wrong way round.
if (Array.prototype.at) {
  Array.prototype.at = function () {};
}

install();
