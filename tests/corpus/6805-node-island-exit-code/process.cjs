exports.setExitCode = (code) => {
  process.exitCode = code;
};

exports.onExit = (label) => {
  process.on("exit", (code) => console.log(`island exit listener ${label} ${code}`));
};
