import * as http from "node:http";
import * as https from "node:https";
import { readFileSync } from "node:fs";
import { request as importedRequest } from "node:http";
import { httpRequest, httpsRequest, httpGet, httpsGet } from "./clients.ts";

const cert = readFileSync("tests/fixtures/server/certs/localhost.pem", "utf8");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem", "utf8");

// Local aliases of the client functions.
const localHttpsRequest = https.request;
const localHttpGet = http.get;

type Done = (status: number, body: string) => void;

// The relay shape: the condition selects between two aliased client
// functions at each call through the binding.
function fetchText(secure: boolean, port: number, path: string, done: Done): void {
  const request = secure ? httpsRequest : httpRequest;
  const req = request(
    {
      hostname: "127.0.0.1",
      port,
      path,
      ...(secure ? { rejectUnauthorized: false } : {}),
    },
    (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => done(res.statusCode ?? -2, body));
    },
  );
  req.on("error", (err) => done(-1, (err as Error).message));
  req.end();
}

// The same selection built from local aliases, per call.
function fetchLocal(secure: boolean, port: number, path: string, done: Done): void {
  const request = secure ? localHttpsRequest : importedRequest;
  const req = request({ hostname: "127.0.0.1", port, path }, (res) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => (body += chunk));
    res.on("end", () => done(res.statusCode ?? -2, body));
  });
  req.on("error", (err) => done(-1, (err as Error).message));
  req.end();
}

// A call straight through an alias, and through the .get pair.
function fetchDirectGet(secure: boolean, port: number, done: Done): void {
  const get = secure ? httpsGet : httpGet;
  const req = get({ hostname: "127.0.0.1", port, path: "/get", rejectUnauthorized: false }, (res) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => (body += chunk));
    res.on("end", () => done(res.statusCode ?? -2, body));
  });
  req.on("error", (err) => done(-1, (err as Error).message));
  req.end();
}

function fetchLocalGet(port: number, done: Done): void {
  const req = localHttpGet({ hostname: "127.0.0.1", port, path: "/local-get" }, (res) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => (body += chunk));
    res.on("end", () => done(res.statusCode ?? -2, body));
  });
  req.on("error", (err) => done(-1, (err as Error).message));
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
    fetchText(false, plainPort, "/a", (status, body) => {
      console.log("text plain:", status, body);
      fetchText(true, securePort, "/b", (status2, body2) => {
        console.log("text secure:", status2, body2);
        fetchLocal(false, plainPort, "/c", (status3, body3) => {
          console.log("local plain:", status3, body3);
          fetchDirectGet(false, plainPort, (status4, body4) => {
            console.log("get plain:", status4, body4);
            fetchDirectGet(true, securePort, (status5, body5) => {
              console.log("get secure:", status5, body5);
              fetchLocalGet(plainPort, (status6, body6) => {
                console.log("local get:", status6, body6);
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
