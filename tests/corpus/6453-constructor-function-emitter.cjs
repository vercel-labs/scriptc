// Constructor functions that inherit from EventEmitter the pre-class way:
// util.inherits and EventEmitter.call(this), the call-without-new guard,
// prototype methods that emit, and the listener API over the instance.
"use strict";
const util = require("util");
const { EventEmitter } = require("events");

util.inherits(Bus, EventEmitter);
function Bus(name) {
  if (!(this instanceof Bus)) return new Bus(name);
  EventEmitter.call(this);
  this.name = name;
  this.entries = [];
}
Bus.prototype.add = function (entry) {
  this.entries.push(entry);
  this.emit("added", entry, this.entries.length);
  return this;
};

// A second level: Sub inherits Bus, and Bus's constructor runs through call.
function Sub(name) {
  Bus.call(this, name);
  this.sub = true;
}
util.inherits(Sub, Bus);
Sub.prototype.add = function (entry) {
  return Bus.prototype.add.call(this, entry.toUpperCase());
};

// Object.setPrototypeOf instead of util.inherits.
function Legacy() {
  EventEmitter.call(this);
}
Object.setPrototypeOf(Legacy.prototype, EventEmitter.prototype);

function main() {
  const bus = Bus("main");
  console.log(bus instanceof Bus, bus instanceof EventEmitter, Bus.super_ === EventEmitter);
  console.log(Object.keys(bus).join(","), bus._eventsCount, bus._maxListeners);
  bus.on("added", function (entry, count) {
    console.log("added", entry, count, this === bus);
  });
  bus.once("added", (entry) => console.log("first only", entry));
  bus.prependListener("added", () => console.log("prepended"));
  bus.prependOnceListener("added", () => console.log("prepended once"));
  bus.add("a").add("b");
  console.log(bus.listenerCount("added"), bus.eventNames(), bus.getMaxListeners());

  const handler = () => console.log("never");
  bus.on("x", handler);
  bus.on("x", () => console.log("kept"));
  bus.off("x", handler);
  console.log(bus.emit("x"), bus.emit("nothing"), bus.listeners("x").length, bus.rawListeners("added").length);

  try {
    bus.emit("error", new Error("boom"));
  } catch (err) {
    console.log("caught", err.message);
  }
  try {
    bus.emit("error", "plain");
  } catch (err) {
    console.log("caught", err.code, err.message);
  }
  bus.on("error", (err) => console.log("handled", err.message));
  bus.emit("error", new Error("quiet"));

  bus.on("newListener", (event, listener) => console.log("newListener", event, typeof listener));
  bus.on("removeListener", (event) => console.log("removeListener", event));
  bus.on("later", () => {});
  bus.removeAllListeners("added");
  console.log(bus.listenerCount("added"), bus.listenerCount("later"));
  bus.removeAllListeners();
  console.log(bus.eventNames().length);

  const sub = new Sub("child");
  sub.on("added", (entry) => console.log("sub added", entry));
  sub.add("c");
  console.log(sub instanceof Sub, sub instanceof Bus, sub instanceof EventEmitter, sub.entries);

  const legacy = new Legacy();
  console.log("legacy", legacy instanceof EventEmitter, legacy.getMaxListeners());
  try {
    legacy.setMaxListeners(-1);
  } catch (err) {
    console.log(err.name, err.code);
  }
  try {
    legacy.on("bad", "not a function");
  } catch (err) {
    console.log(err.name, err.code);
  }
  console.log(new Legacy());

  // The leak warning goes to stderr with the process id: run it in a child
  // and print its output with the id normalized.
  const { spawnSync } = require("child_process");
  const child = spawnSync(process.execPath, [process.argv[1], "leak"], { encoding: "utf8" });
  console.log(child.stdout + child.stderr.replace(/\(node:\d+\)/g, "(node:<pid>)"));
}

function leak() {
  const legacy = new Legacy();
  legacy.setMaxListeners(1);
  legacy.on("many", () => {});
  legacy.on("many", () => {});
  legacy.on("many", () => {});
  console.log("leak", legacy.listenerCount("many"));
  setTimeout(() => console.log("leak done"), 1);
}

if (process.argv[2] === "leak") leak();
else main();
