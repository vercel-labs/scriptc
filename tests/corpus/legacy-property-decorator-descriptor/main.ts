// @tsc-legacy-decorators
// Property decorators that return a descriptor: the truthy result is defined
// on the prototype, and an earlier-applied decorator receives it as its
// third argument, as tsc's `__decorate` chains the results.

function first(target: object, key: string, ...rest: any[]): void {
  const result = rest[0];
  console.log("first sees", result === undefined ? "undefined" : typeof result.get);
}

function second(): any {
  console.log("factory second");
  return (target: any, key: any): any => ({
    get: function (): number {
      return 42;
    },
    configurable: true,
  });
}

class C {
  @first
  @second()
  x = 1;
}

const descriptor = Object.getOwnPropertyDescriptor(C.prototype, "x");
console.log("proto getter", typeof descriptor?.get);
console.log("instance", new C().x);
