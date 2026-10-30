"use strict";
// Error subclasses with a property bag that a later dynamic definition or
// write commits. Object.keys and JSON keep the order in which an instance
// created its properties: a class field before an own `name` that is
// assigned after construction, a `name` a constructor assigns before a
// later property, and a `message` that Error's constructor created before
// all of them.

const messageDescriptor = {
  get() {
    return "described";
  },
  enumerable: true,
  configurable: true,
};

// A factory-built class: the field, then an initializer that assigns `name`
// and defines `message`.
function factory(initializer) {
  class Definition extends Error {
    code = "E_FIELD";
  }
  return function construct() {
    const instance = new Definition();
    initializer(instance);
    return instance;
  };
}
const Fielded = factory((instance) => {
  instance.name = "Fielded";
  Object.defineProperty(instance, "message", messageDescriptor);
});
const fielded = new Fielded();
console.log(Object.keys(fielded).join(","), JSON.stringify(fielded));
fielded.extra = 1;
console.log(Object.keys(fielded).join(","), JSON.stringify(fielded));
fielded.name = "Renamed";
console.log(Object.keys(fielded).join(","), JSON.stringify(fielded), fielded.name);

// A class whose constructor passes a message to Error and then assigns
// `name`; the message is redefined after construction.
class Direct extends Error {
  code = "E_DIRECT";
  constructor() {
    super("constructed");
    this.name = "Direct";
  }
}
function redefine(instance) {
  Object.defineProperty(instance, "message", messageDescriptor);
  instance.extra = 2;
  return instance;
}
const direct = redefine(new Direct());
console.log(Object.keys(direct).join(","), JSON.stringify(direct), direct.name);

// Constructors that assign `name` and then another property, which their
// instances create in that order, with and without a message passed to
// Error, before the message is redefined.
class Named extends Error {
  constructor() {
    super();
    this.name = "Named";
    this.detail = "named";
  }
}
const named = redefine(new Named());
console.log(Object.keys(named).join(","), JSON.stringify(named), named.name);

class NamedMessage extends Error {
  constructor() {
    super("constructed");
    this.name = "NamedMessage";
    this.detail = "named";
  }
}
const namedMessage = redefine(new NamedMessage());
console.log(Object.keys(namedMessage).join(","), JSON.stringify(namedMessage), namedMessage.name);
