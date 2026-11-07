exports.install = () => {
  const previous = process.stdout.write;
  process.stdout.write = function (chunk, encoding, callback) {
    const receiver = this === process.stdout ? "receiver kept" : "receiver lost";
    return previous.call(process.stdout, `[${receiver}] ${chunk}`, encoding, callback);
  };
  // Plain writes: a console line passes a completion handler, and a
  // completion queued while the process exits never runs.
  process.on("exit", () => {
    process.stdout.write("island exit write\n");
    process.stdout.write(Buffer.from("island exit bytes\n"));
  });
};
