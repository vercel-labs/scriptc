import { arrayOf, BOOL, DYN, F64, HTTPCLIENTREQ_T, NETSERVER_T, STRING, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The https builtin call slots. */
export const httpsSignatures = defineLibFnSignatures({
  /** https.request's servername option, stored for the construction call
   * that follows: the TLS name sent and verified, and part of the pooled
   * socket key. The "https." prefix keeps the TLS unit linked. */
  "https.nextServername": { argTypes: [STRING], result: VOID },
  "https.requestDyn": { argTypes: [DYN, BOOL], result: HTTPCLIENTREQ_T },
  "https.requestDynCb": { argTypes: [DYN, BOOL, null], result: HTTPCLIENTREQ_T },
  "https.requestUrlDyn": { argTypes: [STRING, DYN, BOOL], result: HTTPCLIENTREQ_T },
  "https.requestUrlDynCb": { argTypes: [STRING, DYN, BOOL, null], result: HTTPCLIENTREQ_T },
  "https.createServerDyn": { argTypes: [DYN], result: NETSERVER_T },
  "https.createServerDynCb": { argTypes: [DYN, null], result: NETSERVER_T },
  "https.createServer": { argTypes: [null, null, null], result: NETSERVER_T },
  "https.request": {
    argTypes: [STRING, F64, STRING, STRING, F64, arrayOf(STRING), BOOL, BOOL, null],
    result: HTTPCLIENTREQ_T,
  },
  "https.requestCb": {
    argTypes: [STRING, F64, STRING, STRING, F64, arrayOf(STRING), BOOL, BOOL, null, null],
    result: HTTPCLIENTREQ_T,
  },
  /** The URL-string first argument, the http.requestUrl row over TLS:
   * no options means Node's defaults (verification on, default trust
   * anchors), and a non-https scheme is ERR_INVALID_PROTOCOL. */
  "https.requestUrl": { argTypes: [STRING, STRING, BOOL], result: HTTPCLIENTREQ_T },
  "https.requestUrlCb": { argTypes: [STRING, STRING, BOOL, null], result: HTTPCLIENTREQ_T },
  "https.requestAgent": {
    argTypes: [STRING, F64, STRING, STRING, F64, arrayOf(STRING), BOOL, BOOL, null, DYN],
    result: HTTPCLIENTREQ_T,
  },
  "https.requestAgentCb": {
    argTypes: [STRING, F64, STRING, STRING, F64, arrayOf(STRING), BOOL, BOOL, null, DYN, null],
    result: HTTPCLIENTREQ_T,
  },
  // The requestFn binding's runtime-secure rows: https.request's shape
  // with the leading `secure` bool.
  /** A call through a `const requestFn = tls ? https.request :
   * http.request` binding — the module-function-as-value ternary between
   * the two known clients: the https.request row with a leading `secure`
   * bool that picks the dial at RUNTIME (true = the TLS client, exactly
   * https.request; false = the plain client, exactly http.request —
   * rejectUnauthorized/ca ignored there like Node ignores TLS options on
   * http.request). The "https." prefix keeps the TLS unit linked. */
  "https.requestFn": {
    argTypes: [BOOL, STRING, F64, STRING, STRING, F64, arrayOf(STRING), BOOL, BOOL, null],
    result: HTTPCLIENTREQ_T,
  },
  "https.requestFnCb": {
    argTypes: [BOOL, STRING, F64, STRING, STRING, F64, arrayOf(STRING), BOOL, BOOL, null, null],
    result: HTTPCLIENTREQ_T,
  },
  /** The same binding's RUNTIME-OPTIONS rows: the options value is walked
   * at run time (a RequestOptions variable or a spreading literal), and
   * the leading secure bool chooses the dial — false is exactly
   * http.request, TLS options included on that arm like Node ignores them
   * there. */
  "https.requestFnDyn": {
    argTypes: [BOOL, DYN, BOOL],
    result: HTTPCLIENTREQ_T,
  },
  "https.requestFnDynCb": {
    argTypes: [BOOL, DYN, BOOL, null],
    result: HTTPCLIENTREQ_T,
  },
});
