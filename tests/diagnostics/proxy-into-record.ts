// A Proxy where the program's types say "a value of this object type". A
// record slot would hold the properties read through the traps once: a
// copy that no longer follows the target and whose writes reach no trap.
interface Config {
  depth: number;
  label: string;
}
const store: any = { depth: 1, label: "x" };
const handler: any = {
  get(target: any, key: string | symbol): any {
    return key === "depth" ? target.depth * 2 : target[key];
  },
  set(target: any, key: string | symbol, value: any): boolean {
    target[key] = value;
    return true;
  },
};
class Holder {
  config: Config;
  constructor(config: Config) {
    this.config = config;
  }
}
function show(config: Config): string {
  return config.depth + " " + config.label;
}
function make(): Config {
  return new Proxy(store, handler);
}
// The binding a Proxy initializes holds the Proxy; it is refused where it leaves.
const view: Config = new Proxy(store, handler);
const holder = new Holder(new Proxy(store, handler));
const asserted = new Proxy(store, handler) as Config;
store.depth = 5;
console.log(view.depth, show(view));
console.log(make().label, holder.config.depth, asserted.depth);
