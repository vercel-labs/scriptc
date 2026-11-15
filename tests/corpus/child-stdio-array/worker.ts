// Answer the parent's one message, then drop the channel so the child exits
// on its own (the parent's stdio read does not depend on it).
process.once("message", () => process.disconnect());
