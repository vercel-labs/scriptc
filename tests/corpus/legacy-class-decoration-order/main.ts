// @tsc-legacy-decorators
// A class decorator that can replace the class routes the name through the
// decoration-result global, which must already hold the class while static
// initializers, static blocks and decorator bodies run.

function identity(t: typeof Service): typeof Service {
  console.log("decorator sees", Service.name, Service.stage);
  return t;
}

@identity
class Service {
  static stage = (console.log("static sees", Service.name), "initialized");
  static {
    console.log("block sees", Service.name, Service.stage);
  }
}

console.log("after", Service.name, Service.stage);
