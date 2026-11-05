exports.onExit = (label) => {
  process.on("exit", (code) => {
    console.log(`island exit listener ${label} ${code}`);
    process.nextTick(() => console.log("tick from an exit listener never runs"));
  });
};

exports.pending = () => {
  setTimeout(() => console.log("island timer never fires"), 100);
};
