const callbacks = [];

exports.write = (label) => {
  console.log(`island log ${label}`);
  console.info("island info %s", label);
  process.stdout.write(Buffer.from(`island bytes ${label}\n`));
  process.stdout.write(Buffer.from(`island hex ${label}\n`).toString("hex"), "hex");
  process.stdout.write(`island callback ${label}\n`, (error) => {
    callbacks.push(`${label}:${error === null || error === undefined}`);
  });
  process.stdout.write(`island encoding and callback ${label}\n`, "utf8", () => {
    callbacks.push(`${label}:utf8`);
  });
};

exports.warn = (label) => {
  console.error(`island error ${label}`);
  console.warn(`island warn ${label}`);
  process.stderr.write(`island stderr write ${label}\n`);
};

// What island code can read off the stream while a replacement is installed.
exports.probe = () => {
  const { write } = process.stdout;
  return [
    "island sees",
    typeof write,
    write === process.stdout.write,
    write.length,
    JSON.stringify(write.name),
    String(process.stdout.isTTY),
    String(process.stdout.columns),
    process.stdout.fd,
    process.stderr.fd,
    process.stdout.write !== process.stderr.write,
  ].join(" ");
};

exports.callbacks = () => `callbacks ${callbacks.join(" ")}`;
