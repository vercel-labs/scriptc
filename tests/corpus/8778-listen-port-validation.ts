// A number port is validated when listen runs, as Node's validatePort does:
// an integer from 0 to 65535 listens, every other number throws
// ERR_SOCKET_BAD_PORT. The ports here are computed, so nothing is decided
// at compile time, and two literals show the same check.
import * as http from "node:http";
import * as net from "node:net";

const n: number = process.argv.length - 2 + 2; // 2, not a constant to the compiler
const attempt = (label: string, go: (server: net.Server, done: () => void) => void): Promise<void> =>
  new Promise<void>((resolve) => {
    const server = net.createServer();
    server.on("error", (error: Error) => {
      console.log(label, "error event", error.message);
      resolve(undefined);
    });
    try {
      go(server, () => {
        console.log(label, "listening", (server.address() as net.AddressInfo).port > 0);
        server.close(() => resolve(undefined));
      });
    } catch (error) {
      console.log(
        label,
        (error as Error).name,
        (error as NodeJS.ErrnoException).code,
        (error as Error).message,
      );
      resolve(undefined);
    }
  });

async function main(): Promise<void> {
  const big: number = n + 70000;
  const negative: number = -n;
  const fraction: number = n / 4 + 0.25;
  const notANumber: number = Number("x" + n);
  const infinite: number = n / 0;
  const zero: number = n - 2;
  const pastEnd: number = 65534 + n;
  await attempt("big", (server, done) => server.listen(big, done));
  await attempt("negative", (server, done) => server.listen(negative, done));
  await attempt("fraction", (server, done) => server.listen(fraction, done));
  await attempt("NaN", (server, done) => server.listen(notANumber, done));
  await attempt("Infinity", (server, done) => server.listen(infinite, done));
  await attempt("zero", (server, done) => server.listen(zero, done));
  await attempt("past the end", (server, done) => server.listen(pastEnd, done));
  await attempt("with a host", (server, done) => server.listen(big, "127.0.0.1", done));
  await attempt("without a callback", (server, done) => {
    server.listen(big);
    done();
  });
  await attempt("options", (server, done) => server.listen({ port: big }, done));
  await attempt("options with a host", (server, done) =>
    server.listen({ port: fraction, host: "127.0.0.1" }, done),
  );
  await attempt("options zero", (server, done) => server.listen({ port: zero }, done));
  await attempt("literal 70000", (server, done) => server.listen(70000, done));
  await attempt("literal 1.5", (server, done) => server.listen(1.5, done));
  await attempt("literal 0", (server, done) => server.listen(0, done));

  // Every argument is evaluated, left to right, before listen validates the
  // port: a later argument's effect happens, and its exception wins.
  const order: string[] = [];
  const host = (): string => {
    order.push("host");
    return "127.0.0.1";
  };
  const callback = (done: () => void): (() => void) => {
    order.push("callback");
    return done;
  };
  const failing = (): string => {
    order.push("failing host");
    throw new Error("thrown by the host argument");
  };
  await attempt("later arguments", (server, done) => server.listen(big, host(), callback(done)));
  await attempt("later callback", (server, done) => server.listen(fraction, callback(done)));
  await attempt("later options", (server, done) =>
    server.listen({ port: big, host: host() }, callback(done)),
  );
  await attempt("later argument throws", (server, done) =>
    server.listen(big, failing(), callback(done)),
  );
  await attempt("valid port, later arguments", (server, done) =>
    server.listen(zero, host(), callback(done)),
  );
  console.log(order.join(", "));

  const web = http.createServer((_request, response) => response.end("x"));
  try {
    web.listen(big, () => {
      console.log("http listening");
      web.close();
    });
  } catch (error) {
    console.log("http", (error as Error).name, (error as Error).message);
  }
}
main();
