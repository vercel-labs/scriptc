// connect() hosts with a null byte throw before any lookup, in both the
// options and the positional form.
import * as net from "node:net";

function attempt(label: string, run: () => unknown): void {
  try {
    run();
    console.log(label, "ok");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    console.log(label, "throw", e.code, e.name, JSON.stringify(e.message));
  }
}

attempt("options", () => net.connect({ port: 1, host: "127.0.0.1\u0000evil" }));
attempt("positional", () => net.connect(1, "127.0.0.1\u0000evil"));
