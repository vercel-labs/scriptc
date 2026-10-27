// A JavaScript object that Object.defineProperty extends, on some paths
// only, keeps the properties it actually has: the checker declares the
// defined property as a required field of the binding's type.
function thrownInfo(node) {
  var errorInfo = {};
  node &&
    Object.defineProperty(errorInfo, "componentStack", {
      configurable: true,
      enumerable: true,
      get: function () {
        var stack = "\n    in " + node.type;
        Object.defineProperty(errorInfo, "componentStack", { value: stack });
        return stack;
      },
    });
  return errorInfo;
}

function described(name) {
  var target = { name: name };
  Object.defineProperties(target, {
    upper: { enumerable: false, get: () => name.toUpperCase() },
    size: { enumerable: true, value: name.length },
  });
  return target;
}

const empty = thrownInfo(null);
const full = thrownInfo({ type: "Suspense" });
console.log(JSON.stringify(empty), "componentStack" in empty, Object.keys(full));
console.log(JSON.stringify(full), JSON.stringify(full));

const item = described("tea");
console.log(JSON.stringify(item), Object.keys(item), item.upper);
