/* node:os — the slice a CLI needs: platform() (same implementation as
 * process.platform), homedir(), tmpdir() (Node's env cascade), EOL
 * (always "\n" — POSIX pinned, like path.sep), and networkInterfaces()
 * (getifaddrs(3); the interface shapes mirror @types/node's exactly so
 * both type worlds map to the same IR structure). */
declare module "os" {
  export function platform(): string;
  export function homedir(): string;
  export function tmpdir(): string;
  /* uname(2)'s release field — Node's own implementation. */
  export function release(): string;
  /* uname(2)'s sysname field ("Darwin", "Linux") — Node's os.type(). */
  export function type(): string;
  /* Total system memory in bytes (sysctl hw.memsize / sysconf). */
  export function totalmem(): number;
  export function availableParallelism(): number;
  /* The passwd-entry snapshot (uv_os_get_passwd): shell is `string |
   * null` to match @types/node (POSIX always answers the string arm);
   * homedir is pw_dir — NOT os.homedir()'s $HOME-first cascade. The type
   * is interned explicitly in type-mapper.ts (the AddressInfo pattern — this
   * concrete form and @types/node's UserInfo<string> both), and the call
   * assembles field-by-field in lowerOsUserInfoCall. */
  export interface UserInfo {
    username: string;
    uid: number;
    gid: number;
    shell: string | null;
    homedir: string;
  }
  export function userInfo(): UserInfo;
  /* The TARGET platform's line terminator (a compile-time constant:
   * "\r\n" under a win32 triple, "\n" everywhere else). */
  export const EOL: "\r\n" | "\n";
  export interface NetworkInterfaceBase {
    address: string;
    netmask: string;
    mac: string;
    internal: boolean;
    cidr: string | null;
    scopeid?: number;
  }
  export interface NetworkInterfaceInfoIPv4 extends NetworkInterfaceBase {
    family: "IPv4";
  }
  export interface NetworkInterfaceInfoIPv6 extends NetworkInterfaceBase {
    family: "IPv6";
    scopeid: number;
  }
  export type NetworkInterfaceInfo = NetworkInterfaceInfoIPv4 | NetworkInterfaceInfoIPv6;
  export function networkInterfaces(): { [name: string]: NetworkInterfaceInfo[] | undefined };
  /* Host facts, libuv's answers: model/speed/times per logical CPU, the
   * host name, the 1/5/15-minute load averages, uptime in seconds, free
   * memory in bytes, process.arch, uname's machine and version fields,
   * the byte order, and a process's scheduling priority (an omitted pid
   * is the current process). Shapes mirror @types/node's. */
  export interface CpuInfo {
    model: string;
    speed: number;
    times: {
      user: number;
      nice: number;
      sys: number;
      idle: number;
      irq: number;
    };
  }
  export function cpus(): CpuInfo[];
  export function hostname(): string;
  export function loadavg(): number[];
  export function uptime(): number;
  export function freemem(): number;
  export function arch(): string;
  export function machine(): string;
  export function version(): string;
  export function endianness(): "BE" | "LE";
  export function getPriority(pid?: number): number;
  export function setPriority(priority: number): void;
  export function setPriority(pid: number, priority: number): void;
  /* The TARGET platform's null device ("\\\\.\\nul" under a win32 triple). */
  export const devNull: string;
  /* The platform's constants: null-prototype objects with read-only
   * members, `signals` frozen (Node's internalBinding('constants').os). */
  export type SignalConstants = {
    [
      key in
        | "SIGABRT"
        | "SIGALRM"
        | "SIGBUS"
        | "SIGCHLD"
        | "SIGCONT"
        | "SIGFPE"
        | "SIGHUP"
        | "SIGILL"
        | "SIGINT"
        | "SIGIO"
        | "SIGIOT"
        | "SIGKILL"
        | "SIGPIPE"
        | "SIGPOLL"
        | "SIGPROF"
        | "SIGPWR"
        | "SIGQUIT"
        | "SIGSEGV"
        | "SIGSTKFLT"
        | "SIGSTOP"
        | "SIGSYS"
        | "SIGTERM"
        | "SIGTRAP"
        | "SIGTSTP"
        | "SIGTTIN"
        | "SIGTTOU"
        | "SIGUNUSED"
        | "SIGURG"
        | "SIGUSR1"
        | "SIGUSR2"
        | "SIGVTALRM"
        | "SIGWINCH"
        | "SIGXCPU"
        | "SIGXFSZ"
        | "SIGBREAK"
        | "SIGLOST"
        | "SIGINFO"
    ]: number;
  };
  export namespace constants {
    const UV_UDP_REUSEADDR: number;
    namespace signals {}
    const signals: SignalConstants;
    namespace errno {
      const E2BIG: number;
      const EACCES: number;
      const EADDRINUSE: number;
      const EADDRNOTAVAIL: number;
      const EAFNOSUPPORT: number;
      const EAGAIN: number;
      const EALREADY: number;
      const EBADF: number;
      const EBADMSG: number;
      const EBUSY: number;
      const ECANCELED: number;
      const ECHILD: number;
      const ECONNABORTED: number;
      const ECONNREFUSED: number;
      const ECONNRESET: number;
      const EDEADLK: number;
      const EDESTADDRREQ: number;
      const EDOM: number;
      const EDQUOT: number;
      const EEXIST: number;
      const EFAULT: number;
      const EFBIG: number;
      const EHOSTUNREACH: number;
      const EIDRM: number;
      const EILSEQ: number;
      const EINPROGRESS: number;
      const EINTR: number;
      const EINVAL: number;
      const EIO: number;
      const EISCONN: number;
      const EISDIR: number;
      const ELOOP: number;
      const EMFILE: number;
      const EMLINK: number;
      const EMSGSIZE: number;
      const EMULTIHOP: number;
      const ENAMETOOLONG: number;
      const ENETDOWN: number;
      const ENETRESET: number;
      const ENETUNREACH: number;
      const ENFILE: number;
      const ENOBUFS: number;
      const ENODATA: number;
      const ENODEV: number;
      const ENOENT: number;
      const ENOEXEC: number;
      const ENOLCK: number;
      const ENOLINK: number;
      const ENOMEM: number;
      const ENOMSG: number;
      const ENOPROTOOPT: number;
      const ENOSPC: number;
      const ENOSR: number;
      const ENOSTR: number;
      const ENOSYS: number;
      const ENOTCONN: number;
      const ENOTDIR: number;
      const ENOTEMPTY: number;
      const ENOTSOCK: number;
      const ENOTSUP: number;
      const ENOTTY: number;
      const ENXIO: number;
      const EOPNOTSUPP: number;
      const EOVERFLOW: number;
      const EPERM: number;
      const EPIPE: number;
      const EPROTO: number;
      const EPROTONOSUPPORT: number;
      const EPROTOTYPE: number;
      const ERANGE: number;
      const EROFS: number;
      const ESPIPE: number;
      const ESRCH: number;
      const ESTALE: number;
      const ETIME: number;
      const ETIMEDOUT: number;
      const ETXTBSY: number;
      const EWOULDBLOCK: number;
      const EXDEV: number;
      const WSAEINTR: number;
      const WSAEBADF: number;
      const WSAEACCES: number;
      const WSAEFAULT: number;
      const WSAEINVAL: number;
      const WSAEMFILE: number;
      const WSAEWOULDBLOCK: number;
      const WSAEINPROGRESS: number;
      const WSAEALREADY: number;
      const WSAENOTSOCK: number;
      const WSAEDESTADDRREQ: number;
      const WSAEMSGSIZE: number;
      const WSAEPROTOTYPE: number;
      const WSAENOPROTOOPT: number;
      const WSAEPROTONOSUPPORT: number;
      const WSAESOCKTNOSUPPORT: number;
      const WSAEOPNOTSUPP: number;
      const WSAEPFNOSUPPORT: number;
      const WSAEAFNOSUPPORT: number;
      const WSAEADDRINUSE: number;
      const WSAEADDRNOTAVAIL: number;
      const WSAENETDOWN: number;
      const WSAENETUNREACH: number;
      const WSAENETRESET: number;
      const WSAECONNABORTED: number;
      const WSAECONNRESET: number;
      const WSAENOBUFS: number;
      const WSAEISCONN: number;
      const WSAENOTCONN: number;
      const WSAESHUTDOWN: number;
      const WSAETOOMANYREFS: number;
      const WSAETIMEDOUT: number;
      const WSAECONNREFUSED: number;
      const WSAELOOP: number;
      const WSAENAMETOOLONG: number;
      const WSAEHOSTDOWN: number;
      const WSAEHOSTUNREACH: number;
      const WSAENOTEMPTY: number;
      const WSAEPROCLIM: number;
      const WSAEUSERS: number;
      const WSAEDQUOT: number;
      const WSAESTALE: number;
      const WSAEREMOTE: number;
      const WSASYSNOTREADY: number;
      const WSAVERNOTSUPPORTED: number;
      const WSANOTINITIALISED: number;
      const WSAEDISCON: number;
      const WSAENOMORE: number;
      const WSAECANCELLED: number;
      const WSAEINVALIDPROCTABLE: number;
      const WSAEINVALIDPROVIDER: number;
      const WSAEPROVIDERFAILEDINIT: number;
      const WSASYSCALLFAILURE: number;
      const WSASERVICE_NOT_FOUND: number;
      const WSATYPE_NOT_FOUND: number;
      const WSA_E_NO_MORE: number;
      const WSA_E_CANCELLED: number;
      const WSAEREFUSED: number;
    }
    namespace dlopen {
      const RTLD_LAZY: number;
      const RTLD_NOW: number;
      const RTLD_GLOBAL: number;
      const RTLD_LOCAL: number;
      const RTLD_DEEPBIND: number;
    }
    namespace priority {
      const PRIORITY_LOW: number;
      const PRIORITY_BELOW_NORMAL: number;
      const PRIORITY_NORMAL: number;
      const PRIORITY_ABOVE_NORMAL: number;
      const PRIORITY_HIGH: number;
      const PRIORITY_HIGHEST: number;
    }
  }
}

declare module "node:os" {
  export * from "os";
}
