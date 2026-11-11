// The chunk, encoding and callback forms of write() and end(): a string
// encodes with the named encoding (utf8 when there is none), a Buffer
// ignores the encoding argument; the peer reads the encoded bytes, printed
// here as hex. write callbacks fire in write order before the 'finish'
// listeners, end's callback joins that same list, end() answers the
// message so calls chain, and every end form sends what it was given.
import {
  createServer,
  request,
  type ClientRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

const routes: Array<[string, Handler]> = [
  [
    "/encodings",
    (req, res) => {
      res.write("A");
      res.write("é", "latin1");
      res.write("aGVsbG8=", "base64");
      res.write("6869", "hex");
      res.write("hi", "ucs2");
      res.write("é", "binary");
      res.write("hé", "utf8");
      res.end("QQ==", "base64");
    },
  ],
  [
    "/buffers",
    (req, res) => {
      // The encoding argument of a Buffer chunk is ignored, as Node's write_
      // never decodes a Uint8Array.
      res.write(Buffer.from("raw"), "base64");
      res.write(Buffer.from([0, 1, 2]), "hex");
      res.end(Buffer.from("end"), "latin1");
    },
  ],
  [
    "/callbacks",
    (req, res) => {
      const written = res.write("a", () => {
        console.log("write callback a", res.writableEnded);
      });
      console.log("write answered", written, res.write("b", "utf8", () => console.log("write callback b")));
      const ended = res.end("c", () => {
        console.log("end callback", res.writableFinished);
      });
      console.log("end answered", ended === res, res.writableEnded);
      res.on("finish", () => console.log("finish", res.writableFinished));
    },
  ],
  ["/end-empty", (req, res) => res.end()],
  ["/end-data", (req, res) => res.end("data")],
  ["/end-data-encoding", (req, res) => res.end("6869", "hex")],
  [
    "/end-callback",
    (req, res) => {
      res.end(() => console.log("end callback only"));
    },
  ],
  [
    "/end-data-callback",
    (req, res) => {
      res.end("d", () => console.log("end data callback"));
    },
  ],
  [
    "/end-data-encoding-callback",
    (req, res) => {
      res.end("eQ==", "base64", () => console.log("end data encoding callback"));
    },
  ],
  [
    "/end-undefined",
    (req, res) => {
      // end(undefined) is end(): the falsy chunk adds nothing.
      const maybe: string | undefined = undefined;
      res.end(maybe);
      console.log("end undefined", res.writableEnded);
    },
  ],
  [
    "/echo",
    (req, res) => {
      let bytes = 0;
      req.on("data", (chunk: Uint8Array) => {
        bytes += chunk.length;
      });
      req.on("end", () => {
        res.end("read " + bytes.toString());
      });
    },
  ],
];

const server = createServer((req, res) => {
  for (const route of routes) {
    if (route[0] === req.url) {
      route[1](req, res);
      return;
    }
  }
  res.statusCode = 404;
  res.end();
});

function fetchBody(port: number, path: string): Promise<string> {
  return new Promise<string>((resolve) => {
    const outbound: ClientRequest = request(
      { host: "127.0.0.1", port, path, agent: false },
      (response) => {
        let hex = "";
        response.on("data", (chunk: Uint8Array) => {
          hex += Buffer.from(chunk).toString("hex");
        });
        response.on("end", () => resolve(hex));
      },
    );
    outbound.end();
  });
}

async function main(): Promise<void> {
  await new Promise<void>((listening) => {
    server.listen(0, "127.0.0.1", listening);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  for (const route of routes) {
    const hex = await fetchBody(port, route[0]);
    console.log(route[0], hex === "" ? "(empty)" : hex);
  }

  // The client request's own write/end forms: its body reaches the server,
  // which answers with the byte count; write() before end() answers the
  // buffered state, and end() answers the request.
  await new Promise<void>((done) => {
    const outbound = request(
      { host: "127.0.0.1", port, path: "/echo", method: "POST", agent: false },
      (response) => {
        let body = "";
        response.on("data", (chunk: Uint8Array) => {
          body += Buffer.from(chunk).toString();
        });
        response.on("end", () => {
          console.log("client response", JSON.stringify(body));
          done();
        });
      },
    );
    console.log("client write", outbound.write("ab"), outbound.write("cd", "utf8"));
    const answered = outbound.end("ef") === outbound;
    console.log("client end answered", answered, outbound.writableEnded);
  });

  server.close();
}

main();
