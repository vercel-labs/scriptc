// `this` in a class static block is the class constructor, as in Node: the
// prototype flag a library sets for its own type tests, a static field read
// and write, an erased cast of the prototype, and a block's place in source
// order among the field initializers.

interface Vec {
  isVec?: boolean;
  kind?: string;
}

class Vec {
  x: number = 1;
  static version: string = "v1";
  static {
    this.prototype.isVec = true;
  }
}

class Vec3 extends Vec {
  z: number = 2;
  static tag: string = "vec3";
  static {
    this.prototype.kind = "3d";
  }
  static {
    this.tag = "tagged";
  }
}

const v = new Vec();
const v3 = new Vec3();
console.log("vec", v.isVec === true, v.kind === undefined, v.x, Vec.version);
console.log("vec3", v3.isVec === true, v3.kind === "3d", v3.z, Vec3.tag);
console.log("inherits", Vec3.version, v3 instanceof Vec);

interface Marked {
  marked?: boolean;
}

class Marked {
  static label: string = "marked";
  static {
    (Marked.prototype as any).marked = true;
  }
}

console.log("cast", new Marked().marked === true, Marked.label);

class Arrowed {
  static ready: boolean = false;
  static {
    const mark = () => {
      this.ready = true;
    };
    mark();
  }
}

console.log("arrow", Arrowed.ready === true);

class Ordered {
  static trace: string = "start";
  static {
    this.trace = this.trace + "+block1";
  }
  static field: string = "field";
  static {
    this.trace = this.trace + "+block2";
  }
}

console.log("order", Ordered.trace, Ordered.field);

// A static block runs even when nothing reads the class's statics, and a
// subclass's block sees itself, not the base, as `this`.
interface Base {
  fromBase?: string;
}

class Base {
  static {
    this.prototype.fromBase = "base";
  }
}

interface Sub {
  fromSub?: string;
}

class Sub extends Base {
  static {
    (this.prototype as any).fromSub = "sub";
  }
}

const s = new Sub();
console.log("sub", s.fromBase, s.fromSub, (Base.prototype as any).fromSub === undefined);
