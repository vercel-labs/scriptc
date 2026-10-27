// A class whose heritage is the require call itself extends EventEmitter,
// as through a require binding. The class is a value: stored in an untyped
// binding, construction through it runs the subclass constructor.
class Channel extends require("events") {
  constructor(name) {
    super();
    this.name = name;
  }
  send(text) {
    return this.emit("message", this.name, text);
  }
}

const a = new Channel("a");
a.on("message", (from, text) => console.log("message", from, text));
console.log("sent", a.send("hello"), new Channel("b").send("nobody"));

let Ctor;
Ctor = Channel;
const c = new Ctor("c");
c.once("message", (from, text) => console.log("once", from, text));
c.send("one");
c.send("two");

const EventEmitter = require("events");
console.log("instanceof", a instanceof EventEmitter, c instanceof EventEmitter, c instanceof Channel);
console.log("class", typeof Ctor, Ctor.name, Ctor === Channel, a.listenerCount("message"));
