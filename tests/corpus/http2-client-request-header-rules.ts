// A request's pseudo-headers and HTTP/1 connection-specific fields are
// validated before anything is sent:
//
// Node's client throws a TypeError naming the lowercased field before any
// stream exists; only the pseudo-headers the HTTP/2 specification defines
// may appear; and te may carry only the literal "trailers" (compared
// case-sensitively, as Node does). Structurally the same rule applies to
// keep-alive, proxy-connection, upgrade and http2-settings. No server is
// needed: every call under test fails before the dial matters.
import * as http2 from "node:http2";

const client = http2.connect("http://127.0.0.1:1");
client.on("error", () => {});
const attempt = (label: string, headers: http2.OutgoingHttpHeaders): void => {
  try {
    const stream = client.request(headers);
    stream.on("error", () => {});
    stream.end();
    console.log(label, "ok");
  } catch (error) {
    const e = error as { name: string; code?: string; message: string };
    console.log(label, e.name, e.code ?? "(no code)", e.message);
  }
};
attempt("connection", { ":path": "/", ":authority": "example.com", connection: "keep-alive" });
attempt("transfer-encoding", { ":path": "/", ":authority": "example.com", "transfer-encoding": "chunked" });
attempt("te gzip", { ":path": "/", ":authority": "example.com", te: "gzip" });
attempt("te upper", { ":path": "/", ":authority": "example.com", te: "TRAILERS" });
attempt("te trailers", { ":path": "/", ":authority": "example.com", te: "trailers" });
attempt("uppercase name", { ":path": "/", ":authority": "example.com", "X-T": "1" });
attempt("unknown pseudo", { ":path": "/", ":authority": "example.com", ":foo": "1" });
attempt("status pseudo", { ":path": "/", ":authority": "example.com", ":status": "200" });
client.destroy();
