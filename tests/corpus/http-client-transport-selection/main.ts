import * as http from "node:http";
import * as https from "node:https";
import type { RequestOptions } from "node:https";
import { readFileSync } from "node:fs";

const cert = readFileSync("tests/fixtures/server/certs/localhost.pem", "utf8");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem", "utf8");

// The same choice made once at load: the condition is not an identifier
// read, so it is evaluated where the binding is declared and the function
// bodies below read the saved bool.
const sample = new URL("http://127.0.0.1/");
const chosenAtLoad = sample.protocol === "https:" ? https.request : http.request;

type Done = (status: number, body: string) => void;

// The transport is chosen by a URL property inside the function, and the
// options travel as a RequestOptions variable, so both the condition and
// the option walk happen at run time.
function fetchText(url: string, done: Done): void {
  const base = new URL(url);
  const options: RequestOptions = {
    protocol: base.protocol,
    hostname: "127.0.0.1",
    port: Number(base.port),
    path: base.pathname,
    method: "GET",
    headers: {},
    rejectUnauthorized: false,
  };
  const transport = base.protocol === "https:" ? https.request : http.request;
  console.log("chosen:", transport.name, transport.length);
  const req = transport(options, (res) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => (body = body + chunk));
    res.on("end", () => done(res.statusCode ?? -2, body));
  });
  req.on("error", (err) => done(-1, String(err)));
  req.end();
}

// The .get pair chosen the same way, whose arms share their length.
function fetchShouted(url: string, done: Done): void {
  const base = new URL(url);
  const transport = base.protocol !== "http:" ? https.get : http.get;
  console.log("chosen:", transport.name, transport.length);
  const req = transport(
    {
      hostname: "127.0.0.1",
      port: Number(base.port),
      path: "/shout" + base.pathname,
      rejectUnauthorized: false,
    },
    (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body = body + chunk));
      res.on("end", () => done(res.statusCode ?? -2, body));
    },
  );
  req.on("error", (err) => done(-1, String(err)));
  req.end();
}

// A transport chosen inside a function and called by a function declared in
// it, so the saved condition travels as a capture.
function fetchNested(url: string, done: Done): void {
  const base = new URL(url);
  const options: RequestOptions = {
    protocol: base.protocol,
    hostname: "127.0.0.1",
    port: Number(base.port),
    path: base.pathname,
    method: "GET",
    headers: {},
    rejectUnauthorized: false,
  };
  const transport = base.protocol === "https:" ? https.request : http.request;
  function send(): void {
    const req = transport(options, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body = body + chunk));
      res.on("end", () => done(res.statusCode ?? -2, body));
    });
    req.on("error", (err) => done(-1, String(err)));
    req.end();
  }
  console.log("nested chosen:", transport.name, transport.length);
  send();
}

// The load-time choice called from a function body.
function fetchChosen(url: string, done: Done): void {
  const base = new URL(url);
  const options: RequestOptions = {
    protocol: base.protocol,
    hostname: "127.0.0.1",
    port: Number(base.port),
    path: base.pathname,
    method: "GET",
    headers: {},
    rejectUnauthorized: false,
  };
  console.log("load chosen:", chosenAtLoad.name, chosenAtLoad.length);
  const req = chosenAtLoad(options, (res) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => (body = body + chunk));
    res.on("end", () => done(res.statusCode ?? -2, body));
  });
  req.on("error", (err) => done(-1, String(err)));
  req.end();
}

const plain = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("plain " + req.url);
});
const secure = https.createServer({ cert, key }, (req, res) => {
  res.writeHead(201, { "content-type": "text/plain" });
  res.end("secure " + req.url);
});

plain.listen(0, () => {
  secure.listen(0, () => {
    const plainPort = plain.address().port;
    const securePort = secure.address().port;
    fetchText("http://127.0.0.1:" + String(plainPort) + "/a", (status, body) => {
      console.log("plain:", status, body);
      fetchText("https://127.0.0.1:" + String(securePort) + "/b", (status2, body2) => {
        console.log("secure:", status2, body2);
        fetchShouted("http://127.0.0.1:" + String(plainPort) + "/c", (status3, body3) => {
          console.log("get plain:", status3, body3);
          fetchShouted("https://127.0.0.1:" + String(securePort) + "/d", (status4, body4) => {
            console.log("get secure:", status4, body4);
            fetchNested("http://127.0.0.1:" + String(plainPort) + "/e", (status5, body5) => {
              console.log("nested:", status5, body5);
              fetchChosen("http://127.0.0.1:" + String(plainPort) + "/f", (status6, body6) => {
                console.log("load:", status6, body6);
                plain.close();
                secure.close(() => console.log("closed"));
              });
            });
          });
        });
      });
    });
  });
});
