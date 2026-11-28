export class Base {
  base = "base";
  hello(): string {
    return "hello:" + this.base;
  }
}

export class Mid extends Base {
  mid = "mid";
  extra(): string {
    return "extra:" + this.mid;
  }
}

export class Leaf extends Mid {
  leaf = "leaf";
}

export class Factory {
  make(): Base | null {
    return new Leaf();
  }
}

export const factory: Factory = new Factory();
