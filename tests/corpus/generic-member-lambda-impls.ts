// An object literal implements an interface's generic method with a plain
// lambda (`send: (m) => …` for `send<T>(m: Message<T>): string`). The
// lambda takes the contextual signature's type parameters as its own and
// lowers once, erased, like a generic lambda: its parameters hold whatever
// each call passes.

interface Message<T = unknown> {
  content: string;
  details?: T;
}

interface Sender {
  name: string;
  send<T = unknown>(message: Message<T>): string;
  notify<T>(message: Message<T>): void;
  pick<K extends string>(keys: K[], fallback: K): K;
}

const log: string[] = [];

function makeSender(name: string): Sender {
  return {
    name,
    send: (message) => `${name} sent ${message.content} (${message.details === undefined ? "no details" : JSON.stringify(message.details)})`,
    notify: (message) => {
      log.push(`${name} notified ${message.content}`);
    },
    pick: (keys, fallback) => keys[0] ?? fallback,
  };
}

const senders: Sender[] = [makeSender("first"), makeSender("second")];
for (const sender of senders) {
  console.log(sender.send({ content: "hi", details: { n: 3 } }));
  console.log(sender.send({ content: "bare" }));
  console.log(sender.send<number[]>({ content: "list", details: [1, 2] }));
  sender.notify({ content: "ping", details: true });
  console.log(sender.pick(["a", "b"], "z"), sender.pick([], "z"));
}
console.log(log.join("; "));
