// In JavaScript sources, an error's own `name` is listed where it was
// created, as in Node: among the properties a constructor assigns, in
// assignment order, after the fields declared before it, and after every
// other own property when it is assigned after construction.

class AssignedBetween extends Error {
  constructor(message) {
    super(message);
    this.code = "E_CODE";
    this.name = "AssignedBetween";
    this.detail = { at: 1 };
  }
}

class AssignedFirst extends Error {
  constructor(message) {
    super(message);
    this.name = "AssignedFirst";
    this.status = 500;
  }
}

class DeclaredField extends Error {
  kind = "declared";
  constructor(message) {
    super(message);
    this.name = "DeclaredField";
    this.after = true;
  }
}

class NameField extends Error {
  name = "NameField";
  extra = 1;
}

class Base extends Error {
  constructor(message) {
    super(message);
    this.base = 1;
  }
}

class Derived extends Base {
  constructor(message) {
    super(message);
    this.name = "Derived";
    this.derived = 2;
  }
}

class ElementName extends Error {
  constructor(message) {
    super(message);
    this.first = 1;
    this["name"] = "ElementName";
    this.second = 2;
  }
}

class Unnamed extends Error {
  constructor(message) {
    super(message);
    this.extra = 1;
  }
}

function show(label, error) {
  console.log(
    label,
    "|",
    Object.keys(error).join(","),
    "|",
    JSON.stringify(error),
    "|",
    Object.getOwnPropertyNames(error).join(","),
  );
}

show("between", new AssignedBetween("a"));
show("first", new AssignedFirst("b"));
show("declared field", new DeclaredField("c"));
show("name field", new NameField("d"));
show("derived", new Derived("e"));
show("element name", new ElementName("g"));

const late = new Unnamed("f");
late.name = "Late";
show("assigned later", late);

const builtin = new Error("g", { cause: "reason" });
builtin.name = "Renamed";
builtin.code = "E_AFTER";
show("builtin", builtin);
