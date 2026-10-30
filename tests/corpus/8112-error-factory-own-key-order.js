"use strict";
// Errors built by a constructor factory, the way zod 4 builds ZodError: a
// class extending the parent passed in, then an initializer that assigns
// `name`, defines non-enumerable fields and an enumerable `message`
// accessor, and a second initializer that reassigns `name`. JSON and
// Object.keys list `name` before `message`, as they were created, and
// `name` holds the last assignment.

const messageDescriptor = {
  get() {
    return this.state.message ?? JSON.stringify(this.state.issues);
  },
  set(value) {
    this.state.message = value;
  },
  enumerable: true,
  configurable: true,
};

function factory(name, initializer, parent) {
  const Parent = parent ?? Object;
  class Definition extends Parent {}
  Object.defineProperty(Definition, "name", { value: name });
  function construct(def) {
    const instance = parent ? new Definition() : this;
    Object.defineProperty(instance, "state", { value: { issues: def }, enumerable: false });
    initializer(instance, def);
    return instance;
  }
  Object.defineProperty(construct, "init", { value: initializer });
  Object.defineProperty(construct, "name", { value: name });
  return construct;
}

const baseInit = (instance, def) => {
  instance.name = "$BaseError";
  Object.defineProperty(instance, "issues", { value: def, enumerable: false });
  Object.defineProperty(instance, "message", messageDescriptor);
};
const BaseError = factory("$BaseError", baseInit, Error);
const ReportError = factory(
  "ReportError",
  (instance, def) => {
    BaseError.init(instance, def);
    instance.name = "ReportError";
  },
  Error,
);

const report = new ReportError([{ code: "too_small", path: ["title"] }]);
console.log(report.name, report instanceof Error, Object.keys(report).join(","));
console.log(JSON.stringify(report));
console.log(JSON.stringify({ success: false, error: report }));
report.message = "replaced";
console.log(JSON.stringify(report), report.message);
report.name = "Renamed";
console.log(JSON.stringify(report), report.name);

const base = new BaseError([1, 2]);
console.log(base.name, Object.keys(base).join(","), JSON.stringify(base));

// The same steps on a class extending Error directly.
function build(flag) {
  class Direct extends Error {}
  const instance = flag ? new Direct() : {};
  instance.name = "First";
  Object.defineProperty(instance, "message", messageDescriptor);
  Object.defineProperty(instance, "state", { value: { issues: ["i"] }, enumerable: false });
  instance.name = "Second";
  return instance;
}
const direct = build(true);
console.log(Object.keys(direct).join(","), JSON.stringify(direct), direct.name);
