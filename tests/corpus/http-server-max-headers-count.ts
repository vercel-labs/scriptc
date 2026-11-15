// server.maxHeadersCount caps the header lines one connection's parser
// accepts, Host included: one line more than the cap is the parser's 431
// answer. null (the default), 0, negatives and non-integers below 1 leave
// the parser's own limit.
import * as http from "node:http";
import * as net from "node:net";

function exchange(port: number, extraLines: number): Promise<string> {
  return new Promise<string>((resolve) => {
    const conn = net.createConnection(port, "127.0.0.1", () => {
      let head = "GET / HTTP/1.1\r\nHost: example.com\r\n";
      for (let i = 0; i < extraLines; i++) head += `X-Pad-${i}: v\r\n`;
      conn.write(head + "\r\n");
    });
    let text = "";
    conn.setEncoding("utf8");
    conn.on("data", (chunk: string) => {
      text += chunk;
      if (text.includes("\r\n\r\n")) {
        conn.destroy();
        resolve(text.split("\r\n")[0]!);
      }
    });
    conn.on("error", () => {
      resolve("(error)");
    });
  });
}

async function limitCase(value: number | null, extraLines: number): Promise<void> {
  const server = http.createServer((req, res) => {
    res.end(`ok:${Object.keys(req.headers).length}`);
  });
  server.maxHeadersCount = value;
  console.log("limit", value, "read", server.maxHeadersCount);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const status = await exchange((server.address() as net.AddressInfo).port, extraLines);
  console.log("limit", value, "lines", extraLines + 1, "->", status);
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function main(): Promise<void> {
  await limitCase(null, 3);
  await limitCase(4, 3);
  await limitCase(3, 3);
  await limitCase(2, 1);
  await limitCase(1.9, 1);
  await limitCase(0, 60);
  await limitCase(-1, 60);
}

void main();
