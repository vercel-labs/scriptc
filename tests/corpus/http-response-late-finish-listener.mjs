// A response emits 'finish' once. A listener added before end(), or after
// end() but before 'finish' is emitted, runs; one added after 'finish'
// never runs.
import http from "node:http";

const lines = [];

const server = http.createServer((req, res) => {
  res.on("finish", () => lines.push("added before end"));
  res.end("ok");
  res.on("finish", () => lines.push("added after end"));
  res.on("close", () => {
    lines.push("close");
    res.on("finish", () => lines.push("added in close"));
  });
});

server.listen(0, () => {
  http.get(`http://localhost:${server.address().port}/`, (response) => {
    response.resume();
    response.on("end", () =>
      setTimeout(() => server.close(() => lines.forEach((line) => console.log(line))), 10),
    );
  });
});
