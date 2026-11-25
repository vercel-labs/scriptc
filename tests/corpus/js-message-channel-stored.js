// Node's MessageChannel global reached through a stored value: the value
// constructs the channel the direct `new` builds, and calling it without
// `new` throws the TypeError Node throws.
const Channel = MessageChannel;

console.log(typeof MessageChannel, MessageChannel.name, MessageChannel.length);

const direct = new MessageChannel();
console.log(
  typeof direct.port1.postMessage,
  typeof direct.port2.postMessage,
  direct.port1 !== direct.port2,
);

const stored = new Channel();
console.log(typeof stored.port1.postMessage, stored.port1 !== direct.port1);

const { MessageChannel: FromGlobal } = globalThis;
console.log("identity", FromGlobal === Channel, FromGlobal === MessageChannel);

// Through an untyped slot, as a program that kept the constructor in a table
// would call it: Node throws its own TypeError for the missing `new`.
const callValue = (value) => value();
try {
  callValue(Channel);
} catch (error) {
  console.log("without new", error.name, error.message);
}
