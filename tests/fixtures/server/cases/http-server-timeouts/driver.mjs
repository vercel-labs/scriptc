import { request } from "node:http";
const port = Number(process.argv[2]);
await new Promise((resolve, reject) => {
  const req = request({ port, path: "/", agent: false }, (res) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => { body += chunk; });
    res.on("end", () => { console.log(`status=${res.statusCode} body=${body}`); resolve(); });
  });
  req.on("error", reject);
  req.end();
});
