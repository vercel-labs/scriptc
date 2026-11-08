const [task, signal] = process.argv.slice(2);
if (task === "own") {
  if (signal === "SIGINT") process.kill(process.pid, "SIGINT");
  else if (signal === "SIGTERM") process.kill(process.pid, "SIGTERM");
  else if (signal === "SIGHUP") process.kill(process.pid, "SIGHUP");
  else process.kill(process.pid, "SIGUSR2");
  // Reached only when the signal did not end this process.
  setTimeout(() => process.exit(7), 200);
} else {
  process.send!({ ready: true });
  setTimeout(() => process.exit(8), 5000);
}
