// Calling a void generic method through an interface value that classes
// implement (the receiver is a checked-dynamic object, and the call
// dispatches by name to the class's erased method) discards the result, as
// JavaScript does, instead of converting it to `void`.

interface Message<T = unknown> {
  content: string;
  details?: T;
}

interface Channel {
  name: string;
  publish<T = unknown>(message: Message<T>): void;
  count<T>(items: T[]): number;
}

const delivered: string[] = [];

class LogChannel implements Channel {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
  publish<T = unknown>(message: Message<T>): void {
    delivered.push(`${this.name}:${message.content}:${message.details === undefined ? "-" : JSON.stringify(message.details)}`);
  }
  count<T>(items: T[]): number {
    return items.length;
  }
}

class LoudChannel extends LogChannel {
  publish<T = unknown>(message: Message<T>): void {
    super.publish({ content: message.content.toUpperCase(), details: message.details });
  }
}

const channels: Channel[] = [new LogChannel("quiet"), new LoudChannel("loud")];
for (const channel of channels) {
  channel.publish({ content: "hello", details: [1, 2] });
  channel.publish({ content: "bare" });
  const result = channel.publish<string>({ content: "typed", details: "x" });
  console.log(channel.name, result === undefined, channel.count(["a", "b", "c"]));
}
console.log(delivered.join(" | "));

// A class may implement the void member with a method that returns a value;
// JavaScript passes that value on.
class CountingChannel implements Channel {
  name = "counting";
  sent = 0;
  publish<T = unknown>(message: Message<T>): number {
    this.sent++;
    return message.content.length;
  }
  count<T>(items: T[]): number {
    return items.length * 2;
  }
}

const counted: Channel[] = [new CountingChannel(), new LogChannel("plain")];
for (const channel of counted) {
  console.log(channel.name, channel.publish({ content: "four" }));
  console.log(`sent ${channel.publish<number>({ content: "again", details: 2 })}`);
}
