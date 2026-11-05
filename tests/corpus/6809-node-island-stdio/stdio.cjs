exports.write = (label) => {
  console.log(`island log ${label}`);
  process.stdout.write(`island write ${label}\n`);
  console.error(`island error ${label}`);
};

exports.big = (n) => {
  process.stdout.write(`${"i".repeat(n)}\n`);
};

exports.later = (ms) => {
  setTimeout(() => {
    console.log("island timer log");
    console.error("island timer error");
  }, ms);
  setImmediate(() => process.stdout.write("island immediate write\n"));
  process.on("exit", () => {
    console.log("island exit listener log");
    console.error("island exit listener error");
  });
};
