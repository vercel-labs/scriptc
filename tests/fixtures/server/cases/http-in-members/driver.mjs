import http from "node:http";
const port = Number(process.argv[2]);
http.get({ host: "127.0.0.1", port, path: "/" }, (res) => {
  let body = "";
  res.on("data", (c) => (body += c));
  res.on("end", () => console.log(res.statusCode, body));
});
