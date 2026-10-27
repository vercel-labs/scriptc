// An error's own `name` is listed where it was created, as in Node:
// after `message` and `cause`, after the fields created before it, and
// before the fields created after it. A `name` field takes its place among
// the fields, `this.name = ...` in a constructor follows that class's
// fields, and a name assigned after construction follows every other own
// property. Object.keys, JSON.stringify and Object.getOwnPropertyNames
// list the same order, for typed values and values held as `any`.

class AssignedName extends Error {
  extra = 1;
  constructor(message: string) {
    super(message);
    this.name = "AssignedName";
  }
}

class NameField extends Error {
  override name = "NameField";
  extra = 1;
}

class LaterNameField extends Error {
  extra = 1;
  override name = "LaterNameField";
  last = 2;
}

class CodeThenName extends Error {
  code: string;
  constructor(message: string) {
    super(message);
    this.code = "E_CODE";
    this.name = "CodeThenName";
  }
}

class NamedBase extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NamedBase";
  }
}

class ChildOfNamed extends NamedBase {
  child = true;
}

class FieldBase extends Error {
  base = "base";
}

class NamedChild extends FieldBase {
  child = "child";
  constructor(message: string) {
    super(message);
    this.name = "NamedChild";
  }
}

class QuotedName extends Error {
  override "name" = "QuotedName";
  "quoted-extra" = 1;
}

class Unnamed extends Error {
  extra = 1;
}

function dyn(value: unknown): any {
  return value;
}

function show(label: string, error: Error): void {
  console.log(
    label,
    "|",
    Object.keys(dyn(error)).join(","),
    "|",
    JSON.stringify(dyn(error)),
    "|",
    Object.getOwnPropertyNames(dyn(error)).join(","),
  );
}

show("assigned", new AssignedName("a"));
show("field", new NameField("b"));
show("later field", new LaterNameField("c"));
show("code then name", new CodeThenName("d"));
show("child of named", new ChildOfNamed("e"));
show("named child", new NamedChild("f"));
show("quoted name field", new QuotedName("q"));

const late = new Unnamed("g");
late.name = "Late";
show("assigned later", late);

const builtin = new TypeError("h", { cause: 1 });
builtin.name = "Renamed";
show("builtin", builtin);

const viaAny = dyn(new RangeError("i"));
viaAny.code = "E_RANGE";
viaAny.name = "Custom";
viaAny.after = true;
console.log("through any", Object.keys(viaAny).join(","), JSON.stringify(viaAny));

const typed = new AssignedName("j");
console.log("typed keys", Object.keys(typed).join(","), JSON.stringify({ error: typed }));
