// node:diagnostics_channel — the pub/sub core: channel identity by name,
// name/hasSubscribers reads, module-level and channel-level subscribe/
// unsubscribe (one subscriber list — Node's), publish over string and
// object messages, the mid-publish self-unsubscribe (the snapshot rule:
// siblings still fire this round), and the false answers (unsubscribe of
// a never-subscribed fn, hasSubscribers of an unknown channel).
import { channel, hasSubscribers, subscribe, unsubscribe } from "node:diagnostics_channel";
import * as dc from "diagnostics_channel";

const ch = channel("corpus:one");
console.log(ch.name);
console.log(ch.hasSubscribers, hasSubscribers("corpus:one"), hasSubscribers("corpus:never"));

// channel() interns by name: the module-level subscribe lands on the SAME
// subscriber list the channel handle publishes to.
const seen: string[] = [];
const onMessage = (message: unknown, name: string | symbol): void => {
  seen.push(`${String(name)}=${String(message)}`);
};
subscribe("corpus:one", onMessage);
console.log(ch.hasSubscribers);
ch.publish("hello");
ch.publish("again");
console.log(seen.join(","));

// unsubscribe answers whether it removed anything.
const other = (message: unknown, name: string | symbol): void => {
  console.log(`other saw ${String(name)}`);
};
console.log(unsubscribe("corpus:one", other));
console.log(ch.unsubscribe(onMessage));
console.log(ch.hasSubscribers);
ch.publish("nobody");
console.log(seen.join(","));

// Object messages cross as dyn values; the subscriber reads them back.
const obj = dc.channel("corpus:two");
obj.subscribe((message: unknown, name: string | symbol): void => {
  const m = message as { foo: string; n: number };
  console.log(`${String(name)}: ${m.foo} ${m.n}`);
});
obj.publish({ foo: "bar", n: 42 });

// The snapshot rule: a subscriber unsubscribing itself mid-publish still
// lets its sibling fire this round, and is gone the next.
const tri = channel("corpus:three");
const first = (message: unknown, name: string | symbol): void => {
  console.log(`first ${String(message)}`);
  tri.unsubscribe(first);
};
const second = (message: unknown, name: string | symbol): void => {
  console.log(`second ${String(message)}`);
};
tri.subscribe(first);
tri.subscribe(second);
tri.publish("round1");
tri.publish("round2");

// A collection member that is not a Channel is refused by the constructor:
// the event members must be Channel values, and a number asserted past the
// type is validated like any other non-Channel value.
const ev = channel("corpus:events");
const notAChannel = 0 as unknown as dc.Channel;
try {
  dc.tracingChannel({ start: ev, end: ev, asyncStart: ev, asyncEnd: ev, error: notAChannel });
  console.log("collection accepted");
} catch (error) {
  const typed = error as Error & { code?: string };
  console.log("collection refused:", typed.code, "|", typed.message);
}
