// node:http2 session and stream types held in signatures and in a field, with
// no call into node:http2 left and nothing from node:http. The types alone
// link the http2 unit (their reference counting), and that unit releases a
// stream's request and response through the http unit, which has to link too.
import type {
  ClientHttp2Session,
  ClientHttp2Stream,
  Http2Session,
  ServerHttp2Session,
  ServerHttp2Stream,
} from "node:http2";

class Pool {
  current: ClientHttp2Session | undefined = undefined;
  streams = 0;
  attach(stream: ClientHttp2Stream | undefined): number {
    if (stream !== undefined) this.streams++;
    return this.streams;
  }
}

function live(session: Http2Session | undefined): boolean {
  return session !== undefined;
}

function serving(
  session: ServerHttp2Session | undefined,
  stream: ServerHttp2Stream | undefined,
): string {
  return `${session === undefined ? "no session" : "session"}, ${stream === undefined ? "no stream" : "stream"}`;
}

const pool = new Pool();
console.log(pool.current === undefined, pool.attach(undefined), pool.streams);
console.log(live(undefined), live(pool.current));
console.log(serving(undefined, undefined));
