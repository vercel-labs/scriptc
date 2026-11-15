// util.promisify.custom in TypeScript: the key is
// Symbol.for('nodejs.util.promisify.custom'). A truthy function there is
// what util.promisify answers, marked with the key itself; a falsy value
// leaves Node's wrapper, which carries the key with the wrapper as its
// value. The wrapper takes the original's own property descriptors (name,
// length, prototype and every other member), calls the original with the
// call's receiver, and a custom function declared on a prototype is found
// through the chain. The custom property is read once per promisify call.
import * as util from "node:util";

const key = util.promisify.custom as any;

function flags(target: any): string {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor === undefined) return "none";
  return `${typeof descriptor.value} ${descriptor.writable} ${descriptor.enumerable} ${descriptor.configurable}`;
}

function base(a: number, callback: (error: Error | null, value?: number) => void): void {
  callback(null, a + 1);
}

const custom = function customImpl(x: number): Promise<string> {
  return Promise.resolve(`custom:${x}`);
};
Object.defineProperty(base as any, key, { value: custom, configurable: true });
const promoted = util.promisify(base as any) as any;
console.log("identity:", promoted === custom, "flags:", flags(promoted), "key:", key === Symbol.for("nodejs.util.promisify.custom"));

function plain(a: number, callback: (error: Error | null, value?: number) => void): void {
  callback(null, a * 2);
}
const wrapper = util.promisify(plain as any) as any;
console.log("wrapper:", wrapper !== plain, "flags:", flags(wrapper));
console.log("twice:", util.promisify(wrapper) === wrapper);

function withProps(this: any, a: number, b: number, callback: any): void {
  callback(null, [this && this.tag, a, b]);
}
Object.defineProperty(withProps as any, "extra", {
  value: 42,
  writable: true,
  enumerable: true,
  configurable: true,
});
const copies = util.promisify(withProps as any) as any;
console.log("copied:", copies.name, copies.length, copies.extra);
console.log("own:", Object.getOwnPropertyNames(copies).join(","));
const extra = Object.getOwnPropertyDescriptor(copies, "extra");
console.log("extra flags:", extra && `${extra.writable} ${extra.enumerable} ${extra.configurable}`);

const proto: any = {};
const inheritedCustom = function inheritedImpl(): void {};
Object.defineProperty(proto, key, { value: inheritedCustom, configurable: true });
const inheriting = function inheriting(): void {};
Object.setPrototypeOf(inheriting, proto);
const viaProto = util.promisify(inheriting as any) as any;
console.log("inherited:", viaProto === inheritedCustom, viaProto.name);

let reads = 0;
const withGetter = function withGetter(): void {} as any;
Object.defineProperty(withGetter, key, {
  get() {
    reads++;
    return undefined;
  },
  configurable: true,
});
const getterFallback = util.promisify(withGetter) as any;
console.log("getter:", reads, getterFallback !== withGetter, flags(getterFallback));

const shape: any = {
  marker: 42,
  describe(): string {
    return `inherited:${this.marker}`;
  },
};
function inheritedProto(callback: (error: Error | null, value?: number) => void): void {
  callback(null, 7);
}
Object.setPrototypeOf(inheritedProto as any, shape);
const withProto = util.promisify(inheritedProto as any) as any;
console.log("prototype:", withProto.marker, withProto.describe());

function detachedProto(callback: (error: Error | null, value?: number) => void): void {
  callback(null, 8);
}
Object.setPrototypeOf(detachedProto as any, null);
const detached = util.promisify(detachedProto as any) as any;
console.log("detached:", Object.getPrototypeOf(detached));

async function main(): Promise<void> {
  console.log("promoted:", await promoted(5));
  console.log("called:", await wrapper(21));
  console.log("receiver:", JSON.stringify(await copies.call({ tag: "receiver" }, 1, 2)));
  console.log("inherited call:", await withProto(), await detached());
}

main();
