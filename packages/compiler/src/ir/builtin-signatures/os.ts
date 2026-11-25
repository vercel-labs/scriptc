import { arrayOf, BYTES_U8, DYN, F64, STRING, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The os builtin call slots. */
export const osSignatures = defineLibFnSignatures({
  /** node:os: homedir is $HOME else getpwuid(3); tmpdir is Node's env
   * cascade ($TMPDIR/$TMP/$TEMP else /tmp, one trailing slash trimmed).
   * os.platform() lowers to process.platform — one implementation. */
  "os.homedir": { argTypes: [], result: STRING },
  /** os.release(): uname(2)'s release field — Node's own implementation
   * (the kernel version string, e.g. "24.6.0" on macOS 15). Interned; +1
   * per read. Never throws. */
  "os.release": { argTypes: [], result: STRING },
  /** os.type(): uname(2)'s sysname ("Darwin", "Linux"; "Windows_NT" on
   * win32) — Node's uv_os_uname answer. Interned per call; never throws. */
  "os.type": { argTypes: [], result: STRING },
  /** os.totalmem(): total physical memory in bytes. Never throws. */
  "os.totalmem": { argTypes: [], result: F64 },
  /** os.availableParallelism(): CPUs the process may use (libuv's answer), >= 1. Never throws. */
  "os.availableParallelism": { argTypes: [], result: F64 },
  /** os.hostname/machine/version/endianness, freemem, uptime and loadavg:
   * libuv's answers (uname's machine and version fields, gethostname,
   * "LE"/"BE", free memory in bytes, uptime in seconds, the three load
   * averages). Fresh results; never throw. */
  "os.hostname": { argTypes: [], result: STRING },
  "os.machine": { argTypes: [], result: STRING },
  "os.version": { argTypes: [], result: STRING },
  "os.endianness": { argTypes: [], result: STRING },
  "os.freemem": { argTypes: [], result: F64 },
  "os.uptime": { argTypes: [], result: F64 },
  "os.loadavg": { argTypes: [], result: arrayOf(F64) },
  /** os.getPriority(pid): validateInt32 (RangeError ERR_OUT_OF_RANGE),
   * then the priority; a failure throws Node's SystemError. */
  "os.getPriority": { argTypes: [F64], result: F64 },
  /** os.setPriority(pid, priority): validateInt32 for both (priority in
   * -20..19, RangeError ERR_OUT_OF_RANGE), then the priority; a failure
   * throws Node's SystemError. */
  "os.setPriority": { argTypes: [F64, F64], result: VOID },
  /** The checked-dynamic forms, for arguments untyped JavaScript supplies
   * (a string, a boolean, an object, a value only the runtime knows):
   * Node's whole argument ladder runs in the runtime — getPriority's
   * default pid, setPriority's one-argument shift, validateInteger's
   * ERR_INVALID_ARG_TYPE rendered from the value, then the range checks
   * and the call. May throw. */
  "os.getPriorityChk": { argTypes: [DYN], result: F64 },
  "os.setPriorityChk": { argTypes: [DYN, DYN], result: VOID },
  /** os.cpus(): cpusTake snapshots every CPU and answers the count;
   * cpusModel(i) and cpusField(i, k) (k: 0 speed, 1 user, 2 nice, 3 sys,
   * 4 idle, 5 irq) read the snapshot. Never throw. */
  "os.cpusTake": { argTypes: [], result: F64 },
  "os.cpusModel": { argTypes: [F64], result: STRING },
  "os.cpusField": { argTypes: [F64, F64], result: F64 },
  /** os.constants: the per-thread null-prototype constants object (dlopen,
   * errno, signals, priority, UV_UDP_REUSEADDR). Never throws. */
  "os.constants": { argTypes: [], result: DYN },
  /** The os.userInfo() fields (uv_os_get_passwd's slices of the passwd
   * entry for the effective uid): pw_name, pw_shell, pw_dir — the PASSWD
   * homedir, not os.homedir's $HOME-first cascade (Node's own split) —
   * and pw_uid, pw_gid (-1 on Windows). The frontend assembles the
   * UserInfo record from these. +1 fresh strings; a passwd lookup
   * failure aborts (Node throws a system error there — no compiled
   * program path reaches it for the running uid). */
  "os.userName": { argTypes: [], result: STRING },
  "os.userShell": { argTypes: [], result: STRING },
  "os.userHomedir": { argTypes: [], result: STRING },
  /** The same three fields as Buffers (os.userInfo({ encoding: 'buffer' })). */
  "os.userNameBuf": { argTypes: [], result: BYTES_U8 },
  "os.userShellBuf": { argTypes: [], result: BYTES_U8 },
  "os.userHomedirBuf": { argTypes: [], result: BYTES_U8 },
  "os.userUid": { argTypes: [], result: F64 },
  "os.userGid": { argTypes: [], result: F64 },
  /** The single passwd lookup the field libCalls above read: one per
   * userInfo() record instead of one per field. */
  "os.userInfoBegin": { argTypes: [], result: VOID },
  "os.tmpdir": { argTypes: [], result: STRING },
  // Result is the call site's Dict<NetworkInterfaceInfo[]> record (VOID is
  // the dgram.address sentinel — the libCall case checks the structure).
  /** os.networkInterfaces(): getifaddrs(3) → the Dict<NetworkInterfaceInfo[]>
   * record, built inline by the emitter from a runtime snapshot (scr_lib.c).
   * The result type is the CALL SITE's mapped @types/node shape — a pure
   * index-signature record whose value is `Info[] | undefined`, Info a
   * two-record union (IPv4: scopeid `number | undefined` holding undefined;
   * IPv6: scopeid number) — verified structurally by the frontend. Rows
   * match libuv's filter (IFF_UP && IFF_RUNNING, AF_INET/AF_INET6; loopback
   * = internal; MACs from the interface's link-level sibling entry, zeros
   * when absent; cidr from the netmask's contiguous prefix, the null arm
   * when it is missing or non-contiguous). Key/row order follows the OS's
   * getifaddrs enumeration — Node itself does not guarantee an order.
   * Fresh +1 record; never throws (a getifaddrs failure yields {}). */
  "os.networkInterfaces": { argTypes: [], result: VOID },
});
