// A union of a string and a class instance converts with the containing
// operator's ToString: the string arm passes through, and an instance whose
// chain roots at a runtime base without a conversion of its own renders
// through Object.prototype.toString, as in Node.
import { EventEmitter } from "node:events";

class Task extends EventEmitter {
  _name = "";
  name(str?: string): string | Task {
    if (str === undefined) return this._name;
    this._name = str;
    return this;
  }
}

const task = new Task();
console.log(`${task.name()}done`);
console.log("x" + task.name());
console.log(task.name() + " " + "tail");
task.name("build");
console.log(task.name() + "!", String(task.name()));
