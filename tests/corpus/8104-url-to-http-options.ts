// url.urlToHttpOptions builds Node's null-prototype request options from a
// URL, and throws ERR_INVALID_ARG_TYPE for a primitive.
import { urlToHttpOptions } from "node:url";

for (const href of [
  "http://user:pass@foo.bar.com:21/aaa/zzz?l=24#test",
  "https://example.com/",
  "http://[::1]:21",
  "http://%E2%82%AC:p%40ss@host/",
  "ws://h:80/x?",
]) {
  const options = urlToHttpOptions(new URL(href));
  console.log(Object.getPrototypeOf(options) === null, JSON.stringify(options));
  console.log(options.hostname, options.port, options.path, options.auth);
}
try {
  urlToHttpOptions("http://127.0.0.1" as unknown as URL);
} catch (e) {
  const error = e as { name: string; code: string; message: string };
  console.log(error.name, error.code, error.message);
}
