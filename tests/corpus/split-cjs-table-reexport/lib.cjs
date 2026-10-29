console.log("lib: init");
exports.n = 7;
exports.bump = function () {
  exports.n = exports.n + 1;
};
exports.fieldN = 1;
exports.handler = function () {
  return "first";
};
exports.swapHandler = function () {
  exports.handler = function () {
    return "second";
  };
};
class BumpField {
  value = (exports.fieldN = exports.fieldN + 1);
}
exports.BumpField = BumpField;
function render(name) {
  return "hello " + name;
}
exports.render = render;
const firstRender = render;
const renderAlias = (firstRender);
exports.renderAlias = renderAlias;
const receiverKind = () => typeof this;
exports.receiverKind = receiverKind;
const receiverAlias = receiverKind;
exports.receiverAlias = receiverAlias;
var offset = function (value) {
  return value + 3;
};
exports.offset = offset;
let offsetAlias = offset;
exports.offsetAlias = offsetAlias;
function makeOffset(offset) {
  return function (value) {
    return value + offset;
  };
}
exports.factory = makeOffset(10);
const factory = makeOffset(20);
exports.factoryAlias = factory;
function forward(fn) {
  return function (value) {
    return fn.call(this, value);
  };
}
exports.forwardedFactory = forward(function (value) {
  return value + 30;
});
function makeNamedOffset(offset) {
  function add(value) {
    return value + offset;
  }
  return add;
}
exports.namedFactory = makeNamedOffset(40);
function forwardNamed(fn) {
  function wrapper(value) {
    return fn.call(this, value);
  }
  return wrapper;
}
exports.namedForwardedFactory = forwardNamed(function (value) {
  return value + 50;
});
