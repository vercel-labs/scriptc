import {
  BOOL,
  BYTES_U8,
  DYN,
  F64,
  NETSERVER_T,
  NETSOCKET_T,
  SECURECTX_T,
  STRING,
  VOID,
} from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The tls builtin call slots. */
export const tlsSignatures = defineLibFnSignatures({
  // tls/https: cert/key/ca PEM arguments are strings OR Buffers (null =
  // both accepted; the emitter passes data+len either way).
  /** node:tls + node:https (scr_tls.c over scr_net.c/scr_http.c, with
   * the vendored mbedTLS archive — linked only when one of these appears
   * on the IR; moduleUsesTls is the switch, and every tls/https libCall
   * also counts as net AND http use so both units link and install).
   * tls.createServer takes (cert, key[, handler]) — cert/key are PEM
   * strings or Buffers (the emitter passes data+len for either); the
   * handler is Node's 'secureConnection' (fires post-handshake with a
   * socket that behaves exactly like a net socket, the same adapters as
   * net.createServer). https.createServer is (cert, key, handler) with
   * the http request-handler adapters. https.request/requestCb extend
   * the http client row with (…, rejectUnauthorized: bool, ca: PEM
   * string/Buffer — "" for none) and default port 443; everything else
   * (write/end/destroy/events, the response surface) IS the http client
   * surface — the handles are the same kinds. */
  "tls.createServer": { argTypes: [null, null], result: NETSERVER_T },
  "tls.createServerCb": { argTypes: [null, null, null], result: NETSERVER_T },
  /** The SNICallback forms: (cert, key, SNICallback[, handler]). The
   * callback is http2.createSecureServerSni's shape, a function or a
   * function | undefined union. */
  "tls.createServerSni": { argTypes: [null, null, null], result: NETSERVER_T },
  "tls.createServerSniCb": { argTypes: [null, null, null, null], result: NETSERVER_T },
  // The runtime options records (divergence 66's stance): a dyn options
  // value whose members read at runtime; pemDyn extracts a runtime-valued
  // cert/key member (arg 1 is the precomposed fence label).
  /** RUNTIME options records (the divergence-66 stance): the *Dyn
   * creators take a checked-dynamic (dyn) options value whose members
   * read at runtime — cert/key extract like the literal path, members
   * whose literal forms fence THROW the catchable fence at runtime, and
   * undocumented keys drop like Node drops them. tls.pemDyn is the
   * literal walk's runtime-valued cert/key extraction: (value, whatLit)
   * → PEM bytes (strings/Buffers/one-element arrays of those) or the
   * thrown fence. All of them may throw. */
  "tls.pemDyn": { argTypes: [DYN, STRING], result: BYTES_U8 },
  "tls.createServerDyn": { argTypes: [DYN], result: NETSERVER_T },
  "tls.createServerDynCb": { argTypes: [DYN, null], result: NETSERVER_T },
  // tls.connect(port, host, opts[, cb]) — port -1 / host "" read the
  // options record; the callback fires post-handshake (secureConnect).
  /** tls.connect — the TLS client socket: (port, host, opts[, cb]) where
   * port -1 reads options.port, host "" reads options.host, and opts is
   * the runtime (dyn) options record (rejectUnauthorized/ca/servername
   * implemented; other documented members throw the runtime fence). The
   * callback fires post-handshake — Node's secureConnect timing. */
  "tls.connect": { argTypes: [F64, STRING, DYN], result: NETSOCKET_T },
  "tls.connectCb": { argTypes: [F64, STRING, DYN, null], result: NETSOCKET_T },
  /** tls.connect(path[, options][, callback]): the Unix-socket client. */
  "tls.connectPath": { argTypes: [STRING, DYN, null], result: NETSOCKET_T },
  // The TLSSocket member surface (authError's `string | null` union is
  // shape-checked in the special cases in validate.ts — the reqHeader pattern).
  /** The TLSSocket member surface on the socket kind: authorized (bool —
   * Node's verify verdict), authorizationError (the verify-failure CODE
   * STRING or null), the 'secureConnect' registration (a TLS socket's
   * conn list fires at establishment; plain sockets never fire it), and
   * the 'session' registration (fires once with the serialized session —
   * a Buffer; the received-ticket event). */
  "tls.sockAuthorized": { argTypes: [NETSOCKET_T], result: BOOL },
  /** getProtocol() (string | null), getCipher() (CipherNameAndProtocol,
   * undefined before the handshake, null after close) and alpnProtocol
   * (string | false | null), as dyn values. */
  /** tlsSocket.servername (string or false) and getSession() (a Buffer
   * or null) as dyn values, and disableRenegotiation's no-op. */
  "tls.sockDynMember": { argTypes: [NETSOCKET_T, F64], result: DYN },
  /** tlsSocket.exportKeyingMaterial(length, label[, context]); the flag
   * says whether the call supplied a context argument. */
  "tls.sockExportKeyingMaterial": {
    argTypes: [NETSOCKET_T, DYN, DYN, DYN, BOOL],
    result: BYTES_U8,
  },
  /** `x instanceof tls.Server`: the server handle's TLS marker. */
  "tls.serverIs": { argTypes: [NETSERVER_T], result: BOOL },
  /** The same test over a checked-dynamic value (a union operand). */
  "tls.serverIsDyn": { argTypes: [DYN], result: BOOL },
  /** disableRenegotiation(): a no-op call, so the receiver is still
   * evaluated (and its exceptions still surface). */
  "tls.sockDisableRenegotiation": { argTypes: [NETSOCKET_T], result: VOID },
  "tls.sockGetProtocol": { argTypes: [NETSOCKET_T], result: DYN },
  "tls.sockGetCipher": { argTypes: [NETSOCKET_T], result: DYN },
  /** getTLSTicket(): the received session ticket as a dyn Buffer, or
   * undefined (a server socket, or a client without one yet). */
  "tls.sockGetTlsTicket": { argTypes: [NETSOCKET_T], result: DYN },
  "tls.sockAlpnProtocol": { argTypes: [NETSOCKET_T], result: DYN },
  /** getPeerCertificate(detailed) and getCertificate() (the legacy object,
   * {} or null; scr_tls_x509.c), and the DER behind getPeerX509Certificate()
   * and getX509Certificate() (a Buffer, empty without a certificate). */
  "tls.sockGetPeerCertificate": { argTypes: [NETSOCKET_T, DYN], result: DYN },
  "tls.sockGetCertificate": { argTypes: [NETSOCKET_T], result: DYN },
  "tls.sockPeerCertDer": { argTypes: [NETSOCKET_T], result: BYTES_U8 },
  "tls.sockOwnCertDer": { argTypes: [NETSOCKET_T], result: BYTES_U8 },
  "tls.sockAuthError": { argTypes: [NETSOCKET_T], result: VOID },
  "tls.sockOnSecureConnect": {
    argTypes: [NETSOCKET_T, { kind: "func", params: [], ret: VOID }, BOOL],
    result: VOID,
  },
  "tls.sockOnSession": { argTypes: [NETSOCKET_T, null, BOOL], result: VOID },
  /** The 'secure' event: the handshake completed (after secureConnect on
   * a client). Plain sockets never fire it. */
  "tls.sockOnSecure": {
    argTypes: [NETSOCKET_T, { kind: "func", params: [], ret: VOID }, BOOL],
    result: VOID,
  },
  /** new tls.TLSSocket(socket, options) in server mode: a new TLS socket
   * takes over the socket's connection (wrapSocketCtx passes a literal's
   * secureContext member apart from the runtime options record). The
   * record reads at runtime: isServer, cert, key, ALPNProtocols,
   * minVersion and maxVersion are implemented, the client mode and other
   * documented members throw the runtime fence. MAY THROW. */
  "tls.wrapSocket": { argTypes: [NETSOCKET_T, DYN], result: NETSOCKET_T },
  "tls.wrapSocketCtx": { argTypes: [NETSOCKET_T, DYN, SECURECTX_T], result: NETSOCKET_T },
  // createSecureContext({ cert, key }) mints the opaque SNI-answer handle.
  /** tls.createSecureContext({ cert, key }) — parses the PEM pair into an
   * opaque SecureContext handle (secureCtx kind) for SNI callbacks to
   * answer with; cert/key are PEM strings or Buffers like createServer's. */
  "tls.createSecureContext": { argTypes: [null, null], result: SECURECTX_T },
  /** tls.checkServerIdentity(hostname, cert): Node's standalone hostname
   * verification — undefined on a match, the ERR_TLS_CERT_ALTNAME_INVALID
   * error otherwise (a malformed quoted alt-name string throws
   * ERR_TLS_CERT_ALTNAME_FORMAT). */
  "tls.checkServerIdentity": { argTypes: [STRING, DYN], result: DYN },
  /** createSecureContext over a RUNTIME options record (the checked-
   * dynamic lane): Node's typed option validations first (the ciphers/
   * passphrase/engine/version/timeout/ticketKeys ladders), then the pem
   * walk — a validated { cert, key } bag builds the real context.
   * May-throw. */
  "tls.createSecureContextDyn": { argTypes: [DYN], result: SECURECTX_T },
  /** server.addContext(servername, options | SecureContext),
   * server.setSecureContext(options) and the 'tlsClientError' listener of
   * a tls or https server (scr_tls.c). */
  "tls.serverAddContext": { argTypes: [NETSERVER_T, DYN, DYN], result: VOID },
  "tls.serverAddContextCtx": { argTypes: [NETSERVER_T, DYN, SECURECTX_T], result: VOID },
  "tls.serverSetSecureContext": { argTypes: [NETSERVER_T, DYN], result: VOID },
  "tls.serverOnClientError": { argTypes: [NETSERVER_T, null, BOOL], result: VOID },
  /** tls.getCACertificates(type): validateString + the documented name
   * set, then the trailing compiler-rendered fence — ALWAYS THROWS (the
   * error.nodeThrow polymorphic-result carve-out). May-throw seed. */
  "tls.caCertsChk": { argTypes: [DYN, STRING], result: VOID },
  /** TLSSocket.on('keylog') and tls.Server.on('keylog'): Node's NSS
   * key-log lines, each a Buffer. */
  "tls.sockOnKeylog": { argTypes: [NETSOCKET_T, null, BOOL], result: VOID },
  "tls.serverOnKeylog": { argTypes: [NETSERVER_T, null, BOOL], result: VOID },
});
