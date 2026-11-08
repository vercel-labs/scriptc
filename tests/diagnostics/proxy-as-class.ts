// A Proxy where the program's types say "an instance of this class". A
// class slot holds native instances only, so each of these would throw a
// TypeError when it ran; the build refuses them instead.
class Palette {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
  fg(text: string): string {
    return `${this.name}:${text}`;
  }
}
let current: Palette | undefined;
// A forwarding global over an empty object asserted to the class.
const forwarding: Palette = new Proxy({} as Palette, {
  get(_target, prop) {
    if (!current) throw new Error("not initialized");
    return (current as unknown as Record<string | symbol, unknown>)[prop];
  },
});
// Over a real instance.
const real = new Palette("dark");
const wrapped = new Proxy(real, {
  get(target: any, key: string | symbol): any {
    return target[key];
  },
});
const handler: any = {
  get(_target: any, key: string | symbol): any {
    return (real as any)[key];
  },
};
// A `let` binding, a field, an argument, a return, an element, an optional slot, an assertion.
let rebound: Palette = new Proxy({} as any, handler);
class Holder {
  palette: Palette;
  optional: Palette | undefined;
  constructor() {
    this.palette = new Proxy({} as any, handler);
  }
}
function show(palette: Palette): string {
  return palette.fg("a");
}
function lazy(): Palette {
  return new Proxy({} as any, handler);
}
const holder = new Holder();
holder.optional = new Proxy({} as any, handler);
const list: Palette[] = [new Proxy({} as any, handler)];
const asserted = new Proxy({} as any, handler) as Palette;
// A Proxy held untyped is a Proxy; the build sees it enter the class slot.
const untyped: any = new Proxy({} as any, handler);
current = real;
console.log(show(new Proxy({} as any, handler)));
console.log(show(untyped));
console.log(lazy().name, list.length);
console.log(forwarding.name, wrapped.name, rebound.name, holder.palette.name, asserted.name);
