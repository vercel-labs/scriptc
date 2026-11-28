// A legacy method decorator wraps an override on the prototype (a guard or a
// logger around the original body). A base-typed call cannot run the compiled
// body directly without bypassing the wrapper, so it refuses instead.
function logged(target: object, key: string, descriptor: PropertyDescriptor): void {
  const original = descriptor.value as any;
  descriptor.value = function (this: any, ...args: any[]): any {
    console.log("guard", key);
    return original.apply(this, args);
  };
  void target;
}

class Guarded extends Array<number> {
  @logged
  push(...items: number[]): number {
    console.log("push", items.length);
    return super.push(...items);
  }
}

const base: number[] = new Guarded();
console.log(base.push(1));
