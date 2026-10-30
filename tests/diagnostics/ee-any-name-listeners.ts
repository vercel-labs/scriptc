// A listener registered under an unrestricted name can sit in the bucket of
// any event, with any parameter types. So the typed listener array of a
// literal event is refused: calling its elements with the event's tuple
// would pass that listener arguments its parameters do not accept.
import { EventEmitter, getEventListeners } from "node:events";

const emitter = new EventEmitter();
emitter.on("count", (n: number) => console.log(n + 1));
const name = process.argv[2] ?? "count";
emitter.on(name, (label: { text: string }) => console.log(label.text.length));
type CountListener = (n: number) => void;
for (const listener of emitter.listeners("count")) (listener as CountListener)(41);
for (const listener of getEventListeners(emitter, "count")) (listener as CountListener)(41);
