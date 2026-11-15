// String() and string concatenation of a native Proxy produce the text Node
// produces: the Proxy answers the ordinary object conversion through its
// traps, so the inherited Object.prototype.toString is what the tag is.
const target: any = { a: "1" };
const view = new Proxy(target, {
  get(t: any, k: any): any {
    return t[k];
  },
});
console.log("plain " + String(view), String(view), "" + view, `${view}`);
console.log("method " + view.toString(), Object.prototype.toString.call(view));
console.log("array " + String([view]) + " " + String([view, view]));

// A get trap that answers with its own toString wins over the object tag.
const named = new Proxy({} as any, {
  get(t: any, k: any): any {
    if (k === "toString")
      return function (): string {
        return "named";
      };
    return undefined;
  },
});
console.log("named " + String(named) + " " + ("" + named));

// A handler without a get trap forwards every Get to the target, whose
// chain ends in Object.prototype.
const empty = new Proxy({ b: 2 } as any, {});
console.log("empty " + String(empty) + " " + ("" + empty));

// @@toPrimitive answers first when the get trap provides it. The program
// reads the symbol before the conversion: a native symbol exists once the
// program has evaluated it.
const toPrimitive = Symbol.toPrimitive;
const exotic = new Proxy({} as any, {
  get(t: any, k: any): any {
    if (k === toPrimitive) return function (): number { return 7; };
    return undefined;
  },
});
console.log("exotic " + String(exotic) + " " + ("" + exotic));
