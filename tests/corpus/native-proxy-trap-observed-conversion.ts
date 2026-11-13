// A native Proxy's conversions run every Get through its get trap, in Node's
// order, including the symbol-keyed reads the program never names itself:
// ToPrimitive reads Symbol.toPrimitive, and Object.prototype.toString reads
// Symbol.toStringTag. An explicit `.toString()` call reads only toString.
const log: string[] = [];
const traced = new Proxy({} as any, {
  get(t: any, k: any): any {
    log.push(String(k));
    return t[k];
  },
});
function flush(label: string): void {
  console.log(label + ": " + log.join(", "));
  log.length = 0;
}
console.log(String(traced));
flush("String");
console.log(`${traced}`);
flush("template");
console.log(traced + "!");
flush("concat");
console.log(traced.toString());
flush("method");
console.log(Object.prototype.toString.call(traced));
flush("tag");

// `proxy.toString(...)` is a method call: the trap's toString answers, with
// its arguments, and a @@toPrimitive member does not take part. The same
// holds for a Proxy held in a dictionary-typed slot.
const handler: any = {
  get(t: any, k: any): any {
    if (typeof k === "symbol" && k.description === "Symbol.toPrimitive")
      return function (): string {
        return "from toPrimitive";
      };
    if (k === "toString")
      return function (radix?: number): string {
        return "from toString " + radix;
      };
    return t[k];
  },
};
const untyped: any = new Proxy({}, handler);
const slot: Record<string, string> = new Proxy({} as Record<string, string>, handler);
console.log(untyped.toString(), untyped.toString(16));
console.log(slot.toString());
console.log(String(untyped), "" + untyped, `${slot}`);

// A trap that answers a symbol with a non-callable value throws the
// conversion's TypeError.
const broken = new Proxy({} as any, {
  get(t: any, k: any): any {
    if (typeof k === "symbol" && k.description === "Symbol.toPrimitive") return 1;
    return t[k];
  },
});
try {
  console.log(String(broken));
} catch (error: any) {
  console.log(error instanceof TypeError, error.message);
}

// Reflect.get with a symbol key holds the get trap to the target's
// non-configurable, non-writable symbol property.
const fixed = Symbol("fixed");
const loose = Symbol("loose");
const target: any = {};
Object.defineProperty(target, fixed, { value: 1, writable: false, configurable: false });
Object.defineProperty(target, loose, { value: 1, writable: true, configurable: false });
const lying = new Proxy(target, {
  get(t: any, k: any): any {
    return 2;
  },
});
try {
  console.log(Reflect.get(lying, fixed));
} catch (error: any) {
  console.log("Reflect.get", error instanceof TypeError);
}
try {
  console.log(lying[fixed]);
} catch (error: any) {
  console.log("index", error instanceof TypeError);
}
console.log(Reflect.get(lying, loose), lying[loose]);

// Reflect.get passes its receiver to the get trap of a Proxy for a symbol
// key, and through a trap-less Proxy to the target's getter.
const tag = Symbol("tag");
const source: any = {};
Object.defineProperty(source, tag, {
  get(this: any): string {
    return "getter " + (this === receiver);
  },
});
const receiver: any = { name: "receiver" };
const forwarding = new Proxy(source, {});
console.log(Reflect.get(forwarding, tag, receiver));
const seeing = new Proxy({} as any, {
  get(t: any, k: any, r: any): any {
    return "trap " + (r === receiver);
  },
});
console.log(Reflect.get(seeing, tag, receiver));
