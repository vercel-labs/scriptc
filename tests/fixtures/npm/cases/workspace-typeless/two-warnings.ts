// Two distinct typeless package scopes warn independently, but Node's
// default warning reporter prints its trace-warnings hint only after the
// first report in the process.
async function run(): Promise<void> {
  await import("wstypeless");
  await import("wstypeless/other");
}

run();
