// A base method calling `this.set()` where only a subclass is ever
// constructed devirtualizes to the subclass override; a polymorphic `this`
// return resolves per declaring class, so the direct call's subclass
// result upcasts to the base method's type (was an internal compiler error).
class Cookies {
  values: string[] = [];
  set(value: string): this {
    this.values.push(value);
    return this;
  }
  delete(name: string): this {
    return this.set(`${name}=; Max-Age=0`);
  }
}
class MirroredCookies extends Cookies {
  mirror: string[] = [];
  override set(value: string): this {
    super.set(value);
    this.mirror.push(value.toUpperCase());
    return this;
  }
}
const cookies = new MirroredCookies();
cookies.set("a=1").delete("b").set("c=3");
console.log(cookies.values.join(" | "));
console.log(cookies.mirror.join(" | "));
console.log(cookies.delete("d") === cookies, cookies.values.length);
