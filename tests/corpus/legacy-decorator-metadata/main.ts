// @tsc-legacy-decorators
// @tsc-decorator-metadata
// Legacy decorators with `emitDecoratorMetadata`: each decorated member's
// decoration array gains tsc's __metadata entries (design:type,
// design:paramtypes, design:returntype) after the member and parameter
// decorators, and a decorated class gains design:paramtypes from its
// constructor. The entries apply FIRST, so a member decorator that reads
// Reflect.getMetadata sees them. The real reflect-metadata package stores
// the values; the program prints the token each design type serialized to.

import "reflect-metadata";

class Dep {}

interface Iface {
  a: number;
}

enum NumEnum {
  A,
}

enum StrEnum {
  A = "a",
}

function dec(..._args: any[]): any {
  return undefined;
}

function nameOf(value: any): string {
  if (value === undefined) return "undefined";
  if (typeof value === "function") return (value as any).name;
  return typeof value;
}

function tokenOf(value: any): string {
  if (value === Object) return "Object";
  return nameOf(value);
}

function metaClass(label: string): (target: any) => any {
  return (target: any): any => {
    const params = Reflect.getMetadata("design:paramtypes", target);
    console.log(label, "paramtypes", params === undefined ? "-" : params.map(tokenOf).join(","));
    return undefined;
  };
}

function meta(label: string): (target: any, key?: any) => any {
  return (target: any, key?: any): any => {
    const type = Reflect.getMetadata("design:type", target, key);
    const params = Reflect.getMetadata("design:paramtypes", target, key);
    const returned = Reflect.getMetadata("design:returntype", target, key);
    console.log(
      label,
      tokenOf(type),
      params === undefined ? "-" : params.map(tokenOf).join(","),
      returned === undefined ? "-" : tokenOf(returned),
    );
    return undefined;
  };
}

@metaClass("service")
class Service {
  @meta("dep")
  dep: Dep = new Dep();

  @meta("prim")
  prim: string = "";

  @meta("num")
  num: number = 0;

  @meta("flag")
  flag: boolean = false;

  @meta("list")
  list: Dep[] = [];

  @meta("maybe")
  maybe: Dep | null = null;

  @meta("iface")
  iface: Iface = { a: 1 };

  @meta("numEnum")
  numEnum: NumEnum = NumEnum.A;

  @meta("strEnum")
  strEnum: StrEnum = StrEnum.A;

  @meta("fn")
  fn: () => void = () => {};

  @meta("promise")
  promise: Promise<Dep> = Promise.resolve(new Dep());

  @meta("when")
  when: Date = new Date(0);

  constructor(@dec other: Dep) {
    this.dep = other;
  }

  @meta("run")
  run(a: Dep, b: string[], ...rest: number[]): Dep {
    void b;
    void rest;
    return a;
  }

  @meta("plain")
  plain(x: unknown): void {
    void x;
  }
}

@metaClass("pair")
class Pair {
  private _v: Dep = new Dep();

  @meta("getset")
  get v(): Dep {
    return this._v;
  }
  set v(next: Dep) {
    this._v = next;
  }

  private _w: Dep = new Dep();

  @meta("setonly")
  set w(next: Dep) {
    this._w = next;
  }

  private _u: Dep = new Dep();

  @meta("getonly")
  get u(): Dep {
    return this._u;
  }
}

const pair = new Pair();
pair.v = new Dep();
pair.w = new Dep();
console.log("pair", pair.v instanceof Dep, pair.u instanceof Dep);

// A class whose only decoration is a constructor parameter decorator: tsc
// still emits the class decoration step (__param plus design:paramtypes),
// so reading the class value directly answers its parameter types.
class ParamOnly {
  constructor(@dec dep: Dep) {
    void dep;
  }
}

// A getter with a typed return and an UNANNOTATED setter: TypeScript's
// emit serializes the setter's (implicit) parameter type, Object.
class GetterCase {
  private _g: Dep = new Dep();

  @meta("getterUnannotatedSetter")
  get g(): Dep {
    return this._g;
  }
  set g(next) {
    this._g = next as Dep;
  }
}

// A type alias serializes as the type it names: a primitive, an array, a
// callable or a literal union answers its global constructor, while an
// alias to a class (or a construct-only signature) is Object.
type AliasString = string;
type AliasNumber = number;
type AliasBoolean = boolean;
type AliasArray = Dep[];
type AliasFn = () => void;
type AliasLit = "x" | "y";
type AliasCtor = new () => Dep;
type AliasTuple = [number, string];

class AliasCase {
  @meta("aliasString")
  s: AliasString = "";

  @meta("aliasNumber")
  n: AliasNumber = 0;

  @meta("aliasBoolean")
  b: AliasBoolean = false;

  @meta("aliasArray")
  a: AliasArray = [];

  @meta("aliasFn")
  f: AliasFn = () => {};

  @meta("aliasLit")
  lit: AliasLit = "x";

  @meta("aliasCtor")
  ctor: AliasCtor = Dep;

  @meta("aliasClass")
  cls: AliasDep = new Dep();

  @meta("aliasTuple")
  tuple: AliasTuple = [1, "s"];
}

type AliasDep = Dep;

void new GetterCase();
void new AliasCase();

const paramOnly = Reflect.getMetadata("design:paramtypes", ParamOnly);
console.log("paramonly", paramOnly[0] === Dep);

const service = new Service(new Dep());
console.log("constructed", service.dep instanceof Dep, service.prim === "");
