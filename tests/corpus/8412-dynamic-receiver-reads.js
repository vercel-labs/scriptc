// Functions read the call receiver only when their parameters, body or
// nested arrows refer to `this`; the others run the same either way.
function add(a, b) {
  return a + b;
}
function own() {
  return this;
}
function field() {
  return this.k;
}
function fromDefault(a = this.k) {
  return a;
}
function arrowInDefault(read = () => this.k) {
  return read();
}
function arrowReader() {
  return () => this.v;
}
function nestedArrows() {
  return () => () => this.v;
}
function* items() {
  yield this.n;
  yield this.n + 1;
}
function Plain() {}
function Point(x, y) {
  this.x = x;
  this.y = y;
}
Point.prototype.sum = function () {
  return this.x + this.y;
};
function outer() {
  function inner() {
    return this.tag;
  }
  return inner.call({ tag: "inner" });
}
function wrap(fn) {
  return function () {
    return fn.apply(this, arguments);
  };
}
function kind() {
  return typeof this;
}

console.log(add(2, 3), add.call({ k: 1 }, 4, 5), add.apply(null, [6, 7]));
console.log(own() === undefined, own.call(7) === 7);
const holder = { k: "held" };
console.log(field.call(holder), fromDefault.call(holder), fromDefault.call(holder, "given"));
console.log(arrowInDefault.call({ k: "from default arrow" }));
console.log(arrowReader.call({ v: 1 })(), nestedArrows.call({ v: 2 })()());
console.log([...items.call({ n: 10 })].join(","));
const plain = new Plain();
console.log(plain instanceof Plain, Object.keys(plain).length);
const point = new Point(3, 4);
console.log(point.x, point.y, point.sum());
console.log(outer());
const wrapped = wrap(field);
console.log(wrapped.call({ k: "forwarded" }));
console.log(kind(), kind.call({}), kind.call(1));
const box = {
  k: 5,
  read() {
    return this.k;
  },
  constant() {
    return 9;
  },
};
console.log(box.read(), box.constant());
const bound = field.bind({ k: "bound" });
console.log(bound());

function listener(n) {
  return [this === holder, n];
}
function plainListener(n) {
  return n * 2;
}
console.log(listener.call(holder, 21), plainListener.call(holder, 21));

let total = 0;
for (let i = 0; i < 1000; i++) total = add(total, i);
console.log(total);
