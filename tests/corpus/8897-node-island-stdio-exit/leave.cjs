exports.arm = (ms) => {
  process.on("exit", () => {
    console.log("island exit listener");
    process.stdout.write(Buffer.from("island last bytes\n"));
  });
  setTimeout(() => {
    console.log("island last words");
    process.stdout.write("island last write\n");
    process.exit(0);
  }, ms);
};
