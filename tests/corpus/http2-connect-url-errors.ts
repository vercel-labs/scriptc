// http2.connect's authority parse, Node's WHATWG URL rules: a port that is
// not all digits or is 65536+ is an "Invalid URL" TypeError before any dial
// (the net layer's refusal must never reach a socket install), an empty
// port means the default, and a scheme other than http/https is
// ERR_HTTP2_UNSUPPORTED_PROTOCOL.
import * as http2 from "node:http2";

const lines: string[] = [];
const attempt = (label: string, authority: string) => {
  try {
    const session = http2.connect(authority);
    session.on("error", () => {});
    session.destroy();
    lines.push(`${label} ok`);
  } catch (error) {
    const refused = error as Error & { code?: string };
    lines.push(`${label} ${refused.name} ${refused.code} ${refused.message}`);
  }
};

attempt("port-99999", "http://127.0.0.1:99999");
attempt("port-neg", "http://127.0.0.1:-1");
attempt("port-empty", "http://127.0.0.1:");
attempt("port-abc", "http://127.0.0.1:abc");
attempt("port-65536", "http://127.0.0.1:65536");
attempt("port-trailing", "http://127.0.0.1:80abc");
attempt("query", "http://127.0.0.1:80?x=1");
attempt("fragment", "http://127.0.0.1:80#frag");
attempt("query-no-port", "http://127.0.0.1/?x=1");
attempt("not-a-url", "nope");
attempt("empty", "");
attempt("ftp", "ftp://x");

for (const line of lines.sort()) console.log(line);
