// Every worker context installs the inspect renderer for the checked-dynamic
// child kill before it runs program code. Four workers each show an invalid
// signal with Node's inspect text; a context that skipped the install, or
// read another context's, would answer the lite rendering instead.
const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");
const cp = require("node:child_process");

if (isMainThread) {
  const WORKERS = 4;
  const answers = new Array(WORKERS).fill(null);
  let exited = 0;
  for (let i = 0; i < WORKERS; i++) {
    const worker = new Worker(__filename, { workerData: i });
    worker.on("message", (answer) => {
      answers[answer.index] = answer.text;
    });
    worker.on("error", (error) => {
      answers[i] = `worker error ${error.message}`;
    });
    worker.on("exit", () => {
      exited += 1;
      if (exited < WORKERS) return;
      for (const text of answers) console.log(text);
    });
  }
} else {
  const child = cp.spawn("sleep", ["2"]);
  child.on("error", () => {});
  let text;
  try {
    child.kill({});
  } catch (error) {
    text = `${error.code} ${JSON.stringify(error.message)}`;
  }
  if (!child.killed) child.kill("SIGKILL");
  child.on("close", () => parentPort.postMessage({ index: workerData, text }));
}
