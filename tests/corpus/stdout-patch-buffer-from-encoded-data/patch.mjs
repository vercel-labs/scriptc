// Replaces process.stdout.write with a recorder; an exit handler prints what it saw.
const seen = [];
process.stdout.write = function (chunk) {
  const kind = typeof chunk === "string" ? "string" : Buffer.isBuffer(chunk) ? "Buffer" : typeof chunk;
  seen.push(`${kind}:${String(chunk)}`);
  return true;
};
process.on("exit", () => process.stderr.write(`${seen.join("\n")}\n`));
