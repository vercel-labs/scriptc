// An override that narrows a parameter and its result together (an arm of the inherited union, a
// subclass, a value where the base may answer undefined), an async override, and a chain that
// narrows twice. Every call here passes a value the override declares.
class Item {
  id = 1;
}
class Special extends Item {
  id = 2;
  extra = "x";
}
class Base {
  find(key: string | number): Item {
    return new Item();
  }
  maybe(key: string | number): Item | undefined {
    return key === "none" ? undefined : new Item();
  }
  name(key: string | number): string | undefined {
    return typeof key === "string" ? key : undefined;
  }
  async load(key: string | number | undefined): Promise<string> {
    return `base ${String(key)}`;
  }
  step(v: string | number | boolean): string {
    return `base ${String(v)}`;
  }
}
class Mid extends Base {
  find(key: string): Special {
    return new Special();
  }
  maybe(key: string): Item {
    return new Special();
  }
  name(key: string): string {
    return key + "!";
  }
  async load(key: string | number): Promise<string> {
    await Promise.resolve();
    return `mid ${String(key)}`;
  }
  step(v: string | number): string {
    return `mid ${String(v)}`;
  }
}
class Low extends Mid {
  async load(key: string): Promise<string> {
    return `low ${key.length}`;
  }
  step(v: string): string {
    return `low ${v.length}`;
  }
}
const mid = new Mid();
const midAsBase: Base = mid;
console.log(mid.find("a").extra, midAsBase.find("a").id, mid.maybe("a").id, midAsBase.maybe("a")?.id);
console.log(mid.name("b"), midAsBase.name("c"), new Base().maybe("none") === undefined, new Base().name(3) === undefined);
const low = new Low();
const lowAsMid: Mid = low;
const lowAsBase: Base = low;
console.log(await low.load("abc"), await lowAsMid.load("ab"), await lowAsBase.load("a"), await midAsBase.load(7));
console.log(await new Base().load(undefined));
console.log(low.step("abc"), lowAsMid.step("ab"), lowAsBase.step("a"), midAsBase.step(5), new Base().step(true));
