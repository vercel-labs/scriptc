// The two request-limit dials on an http.Server: their defaults, a fractional
// maxRequestsPerSocket (the parsed limit is compared directly, and the
// Keep-Alive hint prints the raw value), HTTP/1.0 requests not counted
// against it, 0 disabling it, and the 503 a dropped request gets even with no
// 'dropRequest' listener attached.
import * as http from "node:http";
import * as net from "node:net";

function exchange(port: number, requests: string[], expected: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const conn = net.createConnection(port, "127.0.0.1", () => conn.write(requests.join("")));
    let text = "";
    conn.setEncoding("utf8");
    conn.on("data", (chunk: string) => {
      text += chunk;
      if (text.split("HTTP/1.1 ").length - 1 < expected) return;
      conn.destroy();
      for (const part of text.split(/(?=HTTP\/1\.1 )/)) {
        const head = part.split("\r\n\r\n")[0]!;
        console.log(head.split("\r\n").filter((line) => !line.startsWith("Date: ")).join("|"));
      }
      resolve();
    });
    conn.on("error", () => resolve());
  });
}

function requests(count: number, version: string): string[] {
  const out: string[] = [];
  for (let i = 1; i <= count; i++) out.push(`GET /r${i} HTTP/${version}\r\nHost: example.com\r\n\r\n`);
  return out;
}

async function main(): Promise<void> {
  const plain = http.createServer(() => {});
  console.log("defaults", plain.maxHeadersCount, plain.maxRequestsPerSocket);
  plain.close();

  const fractional = http.createServer((req, res) => {
    res.setHeader("Content-Length", "2");
    res.end("ok");
  });
  fractional.maxRequestsPerSocket = 1.5;
  console.log("fractional read", fractional.maxRequestsPerSocket);
  await new Promise<void>((resolve) => fractional.listen(0, "127.0.0.1", resolve));
  await exchange((fractional.address() as net.AddressInfo).port, requests(3, "1.1"), 3);
  await new Promise<void>((resolve) => fractional.close(() => resolve()));

  const unframed = http.createServer((req, res) => {
    res.end("hello");
  });
  unframed.maxRequestsPerSocket = 2;
  await new Promise<void>((resolve) => unframed.listen(0, "127.0.0.1", resolve));
  await exchange((unframed.address() as net.AddressInfo).port, requests(3, "1.1"), 3);
  await new Promise<void>((resolve) => unframed.close(() => resolve()));

  const zero = http.createServer((req, res) => {
    res.setHeader("Content-Length", "2");
    res.end("ok");
  });
  zero.maxRequestsPerSocket = 0;
  await new Promise<void>((resolve) => zero.listen(0, "127.0.0.1", resolve));
  await exchange((zero.address() as net.AddressInfo).port, requests(3, "1.1"), 3);
  await new Promise<void>((resolve) => zero.close(() => resolve()));

  const http10 = http.createServer((req, res) => {
    res.setHeader("Content-Length", "2");
    res.end("ok");
  });
  http10.maxRequestsPerSocket = 2;
  const ka10 = requests(3, "1.0").map((text) => text.replace("Host: example.com\r\n", "Host: example.com\r\nConnection: keep-alive\r\n"));
  await new Promise<void>((resolve) => http10.listen(0, "127.0.0.1", resolve));
  await exchange((http10.address() as net.AddressInfo).port, ka10, 3);
  await new Promise<void>((resolve) => http10.close(() => resolve()));
}

void main();
