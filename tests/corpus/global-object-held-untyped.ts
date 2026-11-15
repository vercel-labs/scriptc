// The global object held in an untyped value is the same object: its
// built-in globals answer what they are, an absent name is undefined, the
// names it inherits from Object.prototype are that prototype's members, and
// a property the program writes through the binding is listed by
// Object.keys beside Node's enumerable globals.

const host: any = globalThis;
console.log(typeof host.fetch, typeof host.URL, typeof host.process, typeof host.NaN, typeof host.navigator);
console.log(typeof host.Buffer, typeof host.TextEncoder, typeof host.AbortController, typeof host.performance);
console.log("fetch" in host, "depotNever" in host, typeof host.depotNever, host.window === undefined);
console.log(typeof host.toString, host.hasOwnProperty === Object.prototype.hasOwnProperty, typeof host.constructor);

host.depot = 4;
console.log(host.depot, "depot" in host, typeof host.depot, Object.keys(host).includes("depot"));
console.log(Object.keys(globalThis).includes("fetch"), Object.keys(globalThis).includes("Array"), Object.keys(host).length > 15);

console.log(typeof (globalThis as any).toString, (globalThis as any).toString === undefined);
console.log((globalThis as any).constructor ? "has" : "lacks", Symbol.toStringTag in globalThis);
