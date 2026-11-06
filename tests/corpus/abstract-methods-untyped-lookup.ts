// Abstract methods of classes whose instances reach an untyped property
// lookup. An abstract declaration has no value at run time: the lookup finds
// the implementation of the instance's own class, or of the nearest class
// above it that has one, and a name no class implements reads as undefined.

abstract class Holder {
  abstract current(): string;
  describe(): string {
    return `holding ${this.current()}`;
  }
}

abstract class Host extends Holder {
  abstract screen(): number;
  abstract paths(): string[];
  label(): string {
    return `${this.current()}@${this.screen()}`;
  }
}

class AppHost extends Host {
  current(): string {
    return "conv";
  }
  screen(): number {
    return 3;
  }
  paths(): string[] {
    return ["a", "b"];
  }
}

abstract class Middle extends Host {
  current(): string {
    return "middle";
  }
}

class Leaf extends Middle {
  screen(): number {
    return 7;
  }
  paths(): string[] {
    return [];
  }
}

const read = (o: any, k: string): unknown => o[k];
const call = (o: any, k: string): unknown => {
  const fn = o[k];
  return typeof fn === "function" ? fn.call(o) : `no ${k}`;
};

const hosts: Host[] = [new AppHost(), new Leaf()];
for (const h of hosts) {
  console.log(typeof read(h, "current"), typeof read(h, "screen"), typeof read(h, "missing"));
  console.log(call(h, "current"), call(h, "screen"), JSON.stringify(call(h, "paths")));
  console.log(call(h, "describe"), call(h, "label"), call(h, "missing"));
  console.log(read(h, "current") === read(h, "current"), h.describe(), h.label());
}

const held: unknown = hosts[1];
if (held instanceof Holder) console.log("holder", held.current(), held.describe());
