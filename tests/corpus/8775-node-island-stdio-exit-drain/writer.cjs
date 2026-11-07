exports.install = () => {
  const previous = process.stdout.write;
  process.stdout.write = function (chunk, encoding, callback) {
    const receiver = this === process.stdout ? "receiver kept" : "receiver lost";
    return previous.call(process.stdout, `[${receiver}] ${chunk}`, encoding, callback);
  };
  process.on("exit", () => {
    process.stdout.write("island exit write\n");
    console.log("island exit log");
  });
};
