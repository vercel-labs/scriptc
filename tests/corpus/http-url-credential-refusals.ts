// A URL's userinfo reaches Node's request constructor as the decoded
// "user:pass" auth value. Two refusals happen before any socket: a
// malformed percent escape leaves decodeURIComponent's URIError pending and
// a scheme from the other module is ERR_INVALID_PROTOCOL. Neither may
// allocate credentials, dial, or register a client the caller cannot reach.
import * as http from "node:http";
import * as https from "node:https";

function show(label: string, fn: () => void): void {
  try {
    fn();
    console.log(label, "no throw");
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    console.log(label, `${e.name}:${e.code ?? "-"}:${e.message}`);
  }
}

show("http-bad-user-escape", () => http.get("http://a%ZZ:b@127.0.0.1:1/"));
show("http-bad-pass-escape", () => http.get("http://a:b%ZZ@127.0.0.1:1/"));
show("https-bad-escape", () => https.get("https://a%ZZ:b@127.0.0.1:1/"));
show("http-https-scheme", () => http.get("https://user:pass@127.0.0.1:1/"));
show("https-http-scheme", () => https.get("http://user:pass@127.0.0.1:1/"));
// The decode runs first, as Node's does: a malformed escape answers its
// URIError even when the scheme is the other module's.
show("http-escape-before-scheme", () => http.get("https://a%ZZ:b@127.0.0.1:1/"));
show("https-escape-before-scheme", () => https.get("http://a%ZZ:b@127.0.0.1:1/"));
