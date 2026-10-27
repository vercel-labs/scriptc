import { MessageChannel, MessagePort, Worker, isMainThread, parentPort } from "node:worker_threads";

// 'message' listeners with typed parameters on a worker and its
// parentPort: records and numbers in both directions, and a message that
// carries a transferred MessagePort.
type Job = { id: number; text: string; urgent: boolean };
type Reply = { id: number; length: number; upper: string };

if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url));
  // The worker's replies, then the port's, each in delivery order.
  const replies: string[] = [];
  const portLines: string[] = [];
  let expected = 5;
  const done = (): void => {
    if (--expected > 0) return;
    for (const line of [...replies, ...portLines]) console.log(line);
    void worker.terminate();
  };
  worker.on("message", (reply: Reply | number) => {
    if (typeof reply === "number") replies.push(`count ${reply}`);
    else replies.push(`reply ${reply.id} ${reply.length} ${reply.upper}`);
    done();
  });
  const jobs: Job[] = [
    { id: 1, text: "alpha", urgent: false },
    { id: 2, text: "βeta", urgent: true },
    { id: 3, text: "", urgent: false },
  ];
  for (const job of jobs) worker.postMessage(job);
  worker.postMessage(jobs.length);
  // A port in the message: the worker answers through it.
  const { port1, port2 } = new MessageChannel();
  port1.on("message", (text: string) => {
    portLines.push(`port ${text}`);
    port1.close();
    done();
  });
  worker.postMessage({ port: port2 }, [port2]);
} else {
  let count = 0;
  parentPort!.on("message", (message: Job | number | { port: MessagePort }) => {
    if (typeof message === "number") {
      parentPort!.postMessage(count + message);
    } else if ("port" in message) {
      message.port.postMessage("through the port");
      message.port.close();
    } else {
      count++;
      const text = message.urgent ? message.text.toUpperCase() : message.text;
      parentPort!.postMessage({ id: message.id, length: message.text.length, upper: text });
    }
  });
}
