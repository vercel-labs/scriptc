import { BOOL, BYTES_U8, DGRAMSOCK_T, DYN, F64, STRING, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The dgram builtin call slots. */
export const dgramSignatures = defineLibFnSignatures({
  // node:dgram + node:dns (scr_dgram.c). The message/error listeners and
  // dns.lookup's callback are program-dependent closures (null slots,
  // checked in the libCall case); dgram.address's record result is
  // program-dependent too (VOID here is the envGet sentinel — the libCall
  // case checks the {address, family, port} shape).
  /** node:dgram + node:dns (scr_dgram.c — linked, and
   * scr_dgram_install() emitted, only when one of these appears on the
   * IR; moduleUsesDgram is the switch — dns.lookup rides the same unit).
   * The net listener discipline verbatim: receivers borrowed, CALLBACKS
   * MOVE into the handle's registry and release at settlement, `on` vs
   * `once` is the trailing bool, registrations are void. bind/connect
   * bind NOW and defer 'listening'/'connect' to the next loop turn (the
   * net.listen story); their optional-host completions are ""
   * (bind → 0.0.0.0) and "127.0.0.1" (connect — udp4's Node default).
   * bind/connect/send/close/address THROW Node's state errors ("Socket
   * is already bound", "Already connected", "Not running") — may-throw
   * seeded. dgram.address returns the AddressInfo RECORD (the frontend
   * pins the {address, family, port} shape; the emitter builds it from
   * runtime parts). onMessage adapters are emitted per rinfo record
   * shape (the child.onExit precedent); onError reuses the child %Error
   * adapters. dns.lookup resolves via getaddrinfo AT CALL TIME and
   * defers the callback to the next turn (SEMANTICS.md documents the
   * blocking divergence); its per-union adapter builds the
   * `Error | null` first argument. */
  "dgram.createSocket": { argTypes: [DYN], result: DGRAMSOCK_T },
  /** createSocket's listener form: the callback registers as on('message'). */
  "dgram.createSocketCb": { argTypes: [DYN, null], result: DGRAMSOCK_T },
  /** bind(options[, callback]) — the untyped options object. */
  "dgram.bindOpts": { argTypes: [DGRAMSOCK_T, DYN], result: VOID },
  "dgram.bindOptsCb": {
    argTypes: [DGRAMSOCK_T, DYN, { kind: "func", params: [], ret: VOID }],
    result: VOID,
  },
  /** bindSync(options): binds synchronously; the address record the
   * frontend pins is read back through the address() parts. */
  "dgram.bindSync": { argTypes: [DGRAMSOCK_T, DYN], result: VOID },
  /** connectSync(port[, address]): the synchronous connect. */
  "dgram.connectSync": { argTypes: [DGRAMSOCK_T, F64, STRING, BOOL], result: VOID },
  /** The source-specific multicast joins, interface given flag last. */
  "dgram.addSourceMembership": {
    argTypes: [DGRAMSOCK_T, STRING, STRING, STRING, BOOL],
    result: VOID,
  },
  "dgram.dropSourceMembership": {
    argTypes: [DGRAMSOCK_T, STRING, STRING, STRING, BOOL],
    result: VOID,
  },
  /** socket.type: "udp4" or "udp6". */
  "dgram.type": { argTypes: [DGRAMSOCK_T], result: STRING },
  /** `x instanceof dgram.Socket` over a checked-dynamic value: the
   * socket handle's tag. */
  "dgram.isSocket": { argTypes: [DYN], result: BOOL },
  /** remoteAddress(): the remote AddressInfo record (the frontend pins
   * its {address, family, port} shape, built from the runtime parts). */
  "dgram.remoteAddress": { argTypes: [DGRAMSOCK_T], result: VOID },
  /** socket[Symbol.asyncDispose](): a promise of 'close'. */
  "dgram.asyncDispose": { argTypes: [DGRAMSOCK_T], result: { kind: "promise", inner: VOID } },
  "dgram.bind": { argTypes: [DGRAMSOCK_T, F64, STRING], result: VOID },
  "dgram.bindCb": {
    argTypes: [DGRAMSOCK_T, F64, STRING, { kind: "func", params: [], ret: VOID }],
    result: VOID,
  },
  "dgram.connect": { argTypes: [DGRAMSOCK_T, F64, STRING], result: VOID },
  "dgram.connectCb": {
    argTypes: [DGRAMSOCK_T, F64, STRING, { kind: "func", params: [], ret: VOID }],
    result: VOID,
  },
  /** A connect completion callback read as an untyped value: the runtime
   * calls it with the error when the connection is refused (Node's
   * nextTick(callback, ex)), so a JavaScript callback sees its argument. */
  "dgram.connectDyn": { argTypes: [DGRAMSOCK_T, F64, STRING, DYN], result: VOID },
  "dgram.sendStr": { argTypes: [DGRAMSOCK_T, STRING, F64, STRING], result: VOID },
  "dgram.sendBytes": { argTypes: [DGRAMSOCK_T, BYTES_U8, F64, STRING], result: VOID },
  /** Connected AF_UNIX datagram sockets for the hot-shots package shim
   * (the unix-dgram addon's surface): fd or result >= 0, -errno on
   * failure; send answers 1 when the socket would block. */
  "dgram.unixSocket": { argTypes: [], result: F64 },
  "dgram.unixConnect": { argTypes: [F64, STRING], result: F64 },
  "dgram.unixSend": { argTypes: [F64, BYTES_U8], result: F64 },
  "dgram.unixClose": { argTypes: [F64], result: F64 },
  /** The send argument-validation ladder over dyn arguments (Node's
   * signature shuffle: slice bounds, list/type contracts, port/address
   * validation, connected-state errors), then the send: lists, connected
   * sends and completion callbacks included. Up to six arguments, the
   * missing ones undefined. May-throw. */
  "dgram.sendChk": { argTypes: [DGRAMSOCK_T, DYN, DYN, DYN, DYN, DYN, DYN], result: VOID },
  "dgram.address": { argTypes: [DGRAMSOCK_T], result: VOID },
  "dgram.close": { argTypes: [DGRAMSOCK_T], result: VOID },
  "dgram.closeCb": {
    argTypes: [DGRAMSOCK_T, { kind: "func", params: [], ret: VOID }],
    result: VOID,
  },
  "dgram.unref": { argTypes: [DGRAMSOCK_T], result: VOID },
  "dgram.ref": { argTypes: [DGRAMSOCK_T], result: VOID },
  /** The socket options (scr_dgram.c): the membership calls take the
   * interface and whether it was given. May-throw. */
  "dgram.setBroadcast": { argTypes: [DGRAMSOCK_T, BOOL], result: VOID },
  "dgram.setTTL": { argTypes: [DGRAMSOCK_T, F64], result: F64 },
  "dgram.setMulticastTTL": { argTypes: [DGRAMSOCK_T, F64], result: F64 },
  "dgram.setMulticastLoopback": { argTypes: [DGRAMSOCK_T, BOOL], result: BOOL },
  "dgram.setMulticastInterface": { argTypes: [DGRAMSOCK_T, STRING], result: VOID },
  "dgram.addMembership": { argTypes: [DGRAMSOCK_T, STRING, STRING, BOOL], result: VOID },
  "dgram.dropMembership": { argTypes: [DGRAMSOCK_T, STRING, STRING, BOOL], result: VOID },
  "dgram.getRecvBufferSize": { argTypes: [DGRAMSOCK_T], result: F64 },
  "dgram.getSendBufferSize": { argTypes: [DGRAMSOCK_T], result: F64 },
  "dgram.setRecvBufferSize": { argTypes: [DGRAMSOCK_T, F64], result: VOID },
  "dgram.setSendBufferSize": { argTypes: [DGRAMSOCK_T, F64], result: VOID },
  "dgram.getSendQueueSize": { argTypes: [DGRAMSOCK_T], result: F64 },
  "dgram.getSendQueueCount": { argTypes: [DGRAMSOCK_T], result: F64 },
  "dgram.disconnect": { argTypes: [DGRAMSOCK_T], result: VOID },
  "dgram.onMessage": { argTypes: [DGRAMSOCK_T, null, BOOL], result: VOID },
  "dgram.onError": { argTypes: [DGRAMSOCK_T, null, BOOL], result: VOID },
  "dgram.onListening": {
    argTypes: [DGRAMSOCK_T, { kind: "func", params: [], ret: VOID }, BOOL],
    result: VOID,
  },
  "dgram.onClose": {
    argTypes: [DGRAMSOCK_T, { kind: "func", params: [], ret: VOID }, BOOL],
    result: VOID,
  },
  "dgram.onConnect": {
    argTypes: [DGRAMSOCK_T, { kind: "func", params: [], ret: VOID }, BOOL],
    result: VOID,
  },
});
