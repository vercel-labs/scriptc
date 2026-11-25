// `'k' in instance` answers from the class declaration: every declared field,
// method, getter and setter is present on every instance, Object.prototype's
// names come with the prototype chain, and a name the declaration lacks is
// absent. A union of class arms reduces to the same static answers, one per
// runtime tag.
class Base {
  readonly kind = "base";
  optional: string | undefined;
  stop(): void {
    console.log("base.stop");
  }
  get label(): string {
    return this.kind;
  }
}

class Rich extends Base {
  dispose(): void {
    console.log("rich.dispose");
  }
}

const base = new Base();
console.log("base:", "stop" in base, "kind" in base, "dispose" in base);
console.log("inherited:", "label" in base, "toString" in base, "ownValueOf" in base);
// A declared field is present even while it holds undefined.
console.log("undefined field:", "optional" in base, base.optional);

const rich = new Rich();
console.log("rich:", "dispose" in rich, "stop" in rich, "label" in rich);
// A value held at the base type: the answer follows the RUNTIME class, so a
// subclass that declares the key answers true through its class test.
const aliased: Base = new Rich();
console.log("aliased:", "dispose" in aliased, "stop" in aliased);

function shutDown(target: Base | Rich): void {
  if ("dispose" in target && typeof target.dispose === "function") {
    target.dispose();
    return;
  }
  if ("stop" in target) target.stop();
}

shutDown(new Rich());
shutDown(new Base());

// The receiver still evaluates exactly once when the answer is static.
let built = 0;
function build(): Base {
  built++;
  return new Base();
}
console.log("effects:", "stop" in build(), "nope" in build(), built);
function buildRich(): Rich {
  built++;
  return new Rich();
}
console.log("union effects:", "dispose" in buildRich(), built);

// A class expression and a subclass held at its base type answer too; the
// base-typed slot still carries the subclass's own members through the
// union's own arms only (Rich is an arm above).
const Anonymous = class {
  ping(): number {
    return 1;
  }
};
console.log("class expression:", "ping" in new Anonymous(), "nope" in new Anonymous());
