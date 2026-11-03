// A response ended inside an AsyncLocalStorage store keeps that store as its
// end() context until 'close'. When the store holds a callback that
// captured the response (React's render requests do), the response, its
// context and the store form a cycle; the context has to go once the
// response closes, or every request leaks. The sanitized lane's RC audit
// fails on a leaked request.
import { AsyncLocalStorage } from "node:async_hooks";
import http from "node:http";

const store = new AsyncLocalStorage();
const closed = [];

const server = http.createServer((req, res) => {
  const request = { url: req.url, onClose: () => closed.push(`${request.url} ${res.statusCode}`) };
  res.on("close", () => request.onClose());
  store.run(request, () => {
    res.setHeader("content-type", "text/plain");
    res.end(`rendered ${store.getStore().url}`);
  });
});

/** @returns {Promise<string>} */
function get(port, path) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://localhost:${port}${path}`, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => resolve(body));
      })
      .on("error", reject);
  });
}

await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;
console.log(await get(port, "/page"));
await new Promise((resolve) => server.close(resolve));
// The response's 'close' fires after its client saw the body; wait a turn.
await new Promise((resolve) => setImmediate(resolve));
console.log(closed.join(", "));
