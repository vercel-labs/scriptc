exports.exitLater = (code, ms) => {
  process.on("exit", (exitCode) => console.log(`island exit listener ${exitCode}`));
  setTimeout(() => {
    console.log("island timer exits");
    process.exit(code);
  }, ms);
};
