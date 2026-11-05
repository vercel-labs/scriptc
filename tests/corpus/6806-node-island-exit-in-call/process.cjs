exports.onExit = (label) => {
  process.on("exit", (code) => console.log(`island exit listener ${label} ${code}`));
};

exports.exitNow = (code) => {
  console.log("island exits");
  process.exit(code);
};
