// dgram's options records: createSocket({...}) reads type, reuseAddr,
// ipv6Only, the buffer sizes, signal, lookup and the block lists, and
// bind({...}) reads port, address, exclusive and fd. The program walks the
// documented forms and their error ladders, printing only deterministic
// relationships (never an assigned ephemeral port number).
import * as dgram from "node:dgram";

const out: string[] = [];
const say = (...parts: unknown[]): void => {
  out.push(parts.map((part) => String(part)).join(" "));
};
const fail = (label: string, tag: string, err: unknown): void => {
  const e = err as Error & { code?: string };
  say(label, tag, e.code, JSON.stringify(e.message));
};

type Step = () => void;
const steps: Step[] = [];
const run = (): void => {
  const step = steps.shift();
  if (step === undefined) {
    console.log(out.join("\n"));
    return;
  }
  step();
};

const attempt = (label: string, fn: () => void): void => {
  try {
    fn();
    say(label, "accepted");
  } catch (err) {
    fail(label, "throw", err);
  }
  run();
};

/* Binds `options` on a fresh udp4 socket and reports the outcome once. */
const bindProbe = (label: string, options: unknown): void => {
  const sock = dgram.createSocket("udp4");
  let settled = false;
  const settle = (tag: string, detail: string): void => {
    if (settled) return;
    settled = true;
    say(label, tag, detail);
    sock.close();
    run();
  };
  sock.on("error", (err: Error & { code?: string }) => {
    settle("error", `${err.code} ${JSON.stringify(err.message)}`);
  });
  sock.on("listening", () => {
    const address = sock.address();
    settle("listening", `${address.family} ${address.address} ${address.port > 0 ? "port" : "no-port"}`);
  });
  try {
    sock.bind(options as any);
  } catch (err) {
    settle("throw", `${(err as { code?: string }).code} ${JSON.stringify((err as Error).message)}`);
  }
};

steps.push(
  () => attempt("type-bad", () => dgram.createSocket({ type: "udp5" } as never)),
  () => attempt("recv-negative", () => dgram.createSocket({ type: "udp4", recvBufferSize: -1 })),
  () => attempt("recv-fraction", () => dgram.createSocket({ type: "udp4", recvBufferSize: 1.5 })),
  () => attempt("signal-bad", () => dgram.createSocket({ type: "udp4", signal: {} as AbortSignal })),
  () => bindProbe("bind-127", { port: 0, address: "127.0.0.1" }),
  () => bindProbe("bind-empty", {}),
  () => bindProbe("bind-null", null),
  () => bindProbe("bind-exclusive", { port: 0, exclusive: true }),
  () => bindProbe("bind-overflow", { port: 65536 }),
  () => bindProbe("bind-negative-string", { port: "-1" }),
  () => {
    // two sockets with reuseAddr share one port; one without it does not
    const first = dgram.createSocket({ type: "udp4", reuseAddr: true });
    first.on("error", (err: Error & { code?: string }) => {
      say("reuse-first", "error", err.code);
      first.close();
      run();
    });
    first.bind(0, "127.0.0.1", () => {
      const port = first.address().port;
      const second = dgram.createSocket({ type: "udp4", reuseAddr: true });
      let settled = false;
      const settle = (tag: string): void => {
        if (settled) return;
        settled = true;
        say("reuse-second", tag);
        first.close();
        second.close();
        run();
      };
      second.on("error", (err: Error & { code?: string }) => {
        say("reuse-second", "error", err.code);
        settle("failed");
      });
      second.bind(port, "127.0.0.1", () => settle("listening"));
    });
  },
  () => {
    const controller = new AbortController();
    const sock = dgram.createSocket({ type: "udp4", signal: controller.signal });
    let reported = false;
    const report = (tag: string): void => {
      if (reported) return;
      reported = true;
      say("signal-abort", tag);
      run();
    };
    sock.on("close", () => report("closed"));
    sock.bind(0, "127.0.0.1", () => {
      say("signal-abort", "bound");
      controller.abort();
    });
    setTimeout(() => report("no-close"), 500);
  },
);

run();
