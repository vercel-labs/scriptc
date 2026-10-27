// A class of an import cycle reached before its module body ran: Node
// throws the temporal-dead-zone ReferenceError at the access, and the
// same class works once its module finished.
import { Sink, probed } from "./log.ts";
import {
  early,
  earlyMethod,
  earlyInherited,
  earlyInheritedField,
  earlyName,
  earlyRenamedName,
  earlyRenamed,
  earlyCap,
} from "./stats.ts";

console.log("early:", early);
console.log("early method:", earlyMethod);
console.log("early inherited:", earlyInherited);
console.log("early inherited field:", earlyInheritedField);
console.log("early name:", earlyName);
console.log("early renamed name:", earlyRenamedName);
console.log("early renamed:", earlyRenamed);
console.log("early renamed constant:", earlyCap);
console.log("probed:", probed);
console.log("late:", new Sink("late").tag, Sink.describe(), Sink.hello(), Sink.count, Sink.name);
