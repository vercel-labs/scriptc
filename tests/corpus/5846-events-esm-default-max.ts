// events.defaultMaxListeners through the module's ES module namespace and
// named imports reads the namespace's copy, which keeps the value from
// program start until module.syncBuiltinESMExports() refreshes it. The
// default import and the EventEmitter class read the current default.
import EventEmitterDefault, { defaultMaxListeners, EventEmitter, setMaxListeners } from "node:events";
import * as events from "node:events";
import { syncBuiltinESMExports } from "node:module";

const show = (label: string): void => {
  console.log(
    label,
    events.defaultMaxListeners,
    defaultMaxListeners,
    EventEmitterDefault.defaultMaxListeners,
    EventEmitter.defaultMaxListeners,
  );
};
show("start");
setMaxListeners(20);
show("after setMaxListeners");
EventEmitter.defaultMaxListeners = 7;
show("after assignment");
syncBuiltinESMExports();
show("after sync");
events.setMaxListeners(3);
show("after namespace setMaxListeners");
const emitter = new EventEmitter();
console.log(emitter.getMaxListeners(), events.getMaxListeners(emitter));
