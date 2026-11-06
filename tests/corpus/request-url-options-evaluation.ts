// http.request/http.get(url, options[, callback]) evaluates each argument
// once, in Node's order: an options expression that contributes no members
// still runs (its throw propagates before the dial), an Agent value passed
// next to a protocol option is one object for the protocol check and the
// request, and an untyped callback keeps the two-argument URL form. A
// RequestOptions value is the options record, not a callback.
import * as http from "node:http";

const server = http.createServer((req, res) => res.end(`ok ${req.method} ${req.url}`));

let optionsEvaluations = 0;
function noOptions(): undefined {
  optionsEvaluations += 1;
  console.log("options evaluated", optionsEvaluations);
  return undefined;
}

function throwingOptions(): undefined {
  console.log("throwing options evaluated");
  throw new Error("options threw");
}

let agentEvaluations = 0;
function makeAgent(): http.Agent {
  agentEvaluations += 1;
  return new http.Agent({ keepAlive: false });
}

let resolveNext: () => void = () => {};
function next(): Promise<void> {
  return new Promise<void>((resolve) => {
    resolveNext = resolve;
  });
}

// An untyped callback: Node decides by typeof at run time, and the
// two-argument URL form has always taken one.
const untypedCallback: any = (res: any) => {
  let chunks = 0;
  res.on("data", () => {
    chunks += 1;
  });
  res.on("end", () => {
    console.log("untyped", res.statusCode, chunks > 0);
    resolveNext();
  });
};

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  void (async () => {
    // The options expression contributes nothing to the merge, but it is
    // still evaluated before the request is built.
    const first = next();
    http.get(`${base}/one`, noOptions(), (res) => {
      res.resume();
      res.on("end", () => {
        console.log("no-options", res.statusCode);
        resolveNext();
      });
    });
    await first;

    // Its throw stays catchable and no request is sent.
    try {
      http.get(`${base}/two`, throwingOptions(), () => {});
    } catch (err) {
      console.log("throw", (err as Error).message);
    }

    // One Agent value feeds both the protocol check and the request, in
    // the options-first literal form and in the URL form.
    agentEvaluations = 0;
    const third = next();
    http.get(
      { hostname: "127.0.0.1", port, path: "/three", protocol: "http:", agent: makeAgent() },
      (res) => {
        res.resume();
        res.on("end", () => {
          console.log("options-form agent evaluations", agentEvaluations);
          resolveNext();
        });
      },
    );
    await third;

    agentEvaluations = 0;
    const thirdUrl = next();
    http.get(`${base}/three-url`, { protocol: "http:", agent: makeAgent() }, (res) => {
      res.resume();
      res.on("end", () => {
        console.log("url-form agent evaluations", agentEvaluations);
        resolveNext();
      });
    });
    await thirdUrl;

    // The two-argument form with an any-typed callback.
    const fourth = next();
    http.get(`${base}/four`, untypedCallback);
    await fourth;

    // A RequestOptions value in the two-argument form is the options
    // record: the request carries the method and path it names.
    const typedOptions: http.RequestOptions = { method: "POST", path: "/five" };
    const fifth = next();
    const typedRequest = http.request(`${base}/five-url`, typedOptions);
    typedRequest.on("response", (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      res.on("end", () => {
        console.log("typed request options", res.statusCode, body);
        resolveNext();
      });
    });
    typedRequest.end();

    await fifth;

    // The same value with get(): the request is sent and ended eagerly.
    const typedGetOptions: http.RequestOptions = { path: "/six" };
    const sixth = next();
    http.get(`${base}/six-url`, typedGetOptions).on("response", (res) => {
      res.resume();
      res.on("end", () => {
        console.log("typed get options", res.statusCode);
        resolveNext();
      });
    });
    await sixth;

    server.close();
  })();
});
