// One native EventEmitter used both through its static type and through an
// untyped reference: typed and untyped listeners of the same event share
// one listener list, so emits from either side reach every listener in
// registration order, with once, prepend, off and listenerCount over the
// whole list. Untyped emits pass their arguments as given (extra ones
// included) to untyped listeners and the event's typed tuple to typed ones.
import { EventEmitter } from "node:events";

const e = new EventEmitter();
const d: any = e;
const log: string[] = [];
const typed = (n: number, s: string): void => {
  log.push(`typed ${n} ${s}`);
};
e.on("tick", typed);
d.on("tick", (...args: any[]) => {
  log.push(`untyped ${JSON.stringify(args)}`);
});
e.once("tick", (n: number) => {
  log.push(`typed once ${n}`);
});
d.once("tick", (n: any) => {
  log.push(`untyped once ${n}`);
});
d.prependListener("tick", () => {
  log.push("untyped first");
});
console.log(e.listenerCount("tick"), d.listenerCount("tick"));
console.log(e.emit("tick", 1, "a"));
console.log(d.emit("tick", 2, "b", "extra"));
console.log(e.listenerCount("tick"), d.listenerCount("tick"), d.listenerCount("tick", typed));
d.off("tick", typed);
e.emit("tick", 3, "c");
d.emit("tick", 4, "d");
console.log(log.join("\n"));
log.length = 0;

// A typed prefix listener next to untyped listeners of a longer tuple.
e.on("pair", (a: string) => log.push(`prefix ${a}`));
d.on("pair", (a: any, b: any) => log.push(`untyped ${a} ${b}`));
e.emit("pair", "x", 1);
d.emit("pair", "y", 2);
console.log(log.join("\n"));

// Names only untyped code uses stay untyped, and an emit nobody hears
// answers false.
d.on("loose", (...args: any[]) => console.log("loose", args.length, args));
console.log(d.emit("loose"), d.emit("loose", null, [1], { k: true }));
console.log(d.emit("nobody", 1), e.emit("tick", 5, "e"));
console.log(d.eventNames(), e.eventNames());
