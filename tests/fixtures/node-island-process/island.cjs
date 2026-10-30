// The island half of the process-integration fixtures (scope-B NI-3).
exports.onExit = (label) => {
  process.on("exit", (code) => console.log(`island exit listener ${label} ${code}`));
};

exports.throwLater = (ms) => {
  setTimeout(() => {
    throw new Error("island boom");
  }, ms);
};

exports.rejectLater = (ms) => {
  setTimeout(() => {
    Promise.reject(new Error("island rejected"));
  }, ms);
};

exports.timer = (ms, label) => {
  setTimeout(() => console.log(`island timer ${label}`), ms);
};
