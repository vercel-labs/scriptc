/* A class's statics are readable through a class value whose type no longer
 * names them: `(ctor as any).x`, a `typeof Base` parameter, and a record
 * type the class value is passed as. The class object carries the same
 * property table Node's class objects have, so Reflect.get and
 * Object.getOwnPropertyDescriptor answer off it too. */
class Base {
  tag: string = "";
  static kind: string = "base";
  static get label(): string {
    return "base:" + Base.kind;
  }
}
class Sub extends Base {
  static observedAttributes: readonly string[] = ["open"];
  static get label(): string {
    return "sub:" + Sub.kind;
  }
  static describe(): string {
    return "describe";
  }
}

function readAny(ctor: any): string {
  const seen = ctor.observedAttributes;
  return seen === undefined ? "none" : seen.join(",");
}
function readNew(ctor: new () => Base): string {
  return String((ctor as any).label) + "/" + String((ctor as any).kind);
}
function readShape(ctor: { observedAttributes: readonly string[] }): string {
  return ctor.observedAttributes.join("+");
}
function readMethod(ctor: any): string {
  return typeof ctor.describe + ":" + String(ctor.describe());
}
function reflect(ctor: any): string {
  return String(Reflect.get(ctor, "label")) + "/" + String(Reflect.get(ctor, "kind"));
}
function descriptor(ctor: any): string {
  const d = Object.getOwnPropertyDescriptor(ctor, "label")!;
  return typeof d.get + "/" + String(d.enumerable) + "/" + String(d.configurable);
}

console.log("any", readAny(Sub), readAny(Base));
console.log("new", readNew(Sub), readNew(Base));
console.log("shape", readShape(Sub as any));
console.log("method", readMethod(Sub));
console.log("reflect", reflect(Sub), reflect(Base));
console.log("descriptor", descriptor(Sub));
console.log("names", Object.getOwnPropertyNames(Sub).join(","));
const holder: any = { ctor: Sub };
holder.ctor.tag = "written";
console.log("write", String(Reflect.get(Sub, "tag")), holder.ctor.tag);
