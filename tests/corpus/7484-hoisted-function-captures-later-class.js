function f(params) {
  function early() {
    return make;
  }
  const Parent = params?.Parent ?? Object;
  class D extends Parent {}
  function make() {
    return new D();
  }
  return early()();
}
console.log(typeof f(), typeof f({ Parent: Error }));
function g() {
  function early() {
    return make;
  }
  class E {}
  function make() {
    return new E();
  }
  return early()();
}
console.log(typeof g());
