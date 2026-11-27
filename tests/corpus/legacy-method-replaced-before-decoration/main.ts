// @tsc-legacy-decorators
// A static block replaces a decorated method before its decoration runs.
// The decorator's descriptor must be the prototype's CURRENT descriptor, so
// the replacement survives the decoration step, as in tsc's emit.

function dec(target: object, key: string, descriptor: PropertyDescriptor): void {
  console.log("descriptor is the replacement:", descriptor.value === (C.prototype as any).m);
}

class C {
  static {
    (C.prototype as any).m = function (): number {
      return 2;
    };
  }

  @dec
  m(): number {
    return 1;
  }
}

console.log("call", new C().m());
