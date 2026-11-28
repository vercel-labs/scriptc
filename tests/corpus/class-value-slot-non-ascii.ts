// A base class with eight or more ABI-compatible subclasses indexes its
// class-value checks by slot, folding the key's UTF-8 bytes. Non-ASCII
// subclass names exercise that fold: the compiler and the runtime must
// measure a key's byte length and last four bytes the same way, or a
// subclass read through an untyped value is rejected as not a Base.
class Base {
  kind: string = "base";
}
class Émile extends Base {}
class Ámbar extends Base {}
class Øresund extends Base {}
class Łódź extends Base {}
class Þór extends Base {}
class Çelik extends Base {}
class Ñandú extends Base {}
class Ωmega extends Base {}

function build(ctor: new () => Base): Base {
  return new ctor();
}

const ctors: any[] = [Émile, Ámbar, Øresund, Łódź, Þór, Çelik, Ñandú, Ωmega];
for (const untyped of ctors) {
  const cls: new () => Base = untyped;
  console.log(cls.name, build(cls).kind);
}
const baseCls: new () => Base = Base;
console.log("base", build(baseCls).kind);
