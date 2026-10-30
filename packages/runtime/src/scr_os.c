/* node:os host facts: hostname, machine, version, endianness, freemem,
 * uptime, loadavg, getPriority, cpus and constants. Each answer follows the
 * libuv 1.51 routine Node delegates to, platform by platform; strings come
 * back +1 fresh and nothing here throws except getPriority. */
#if defined(__linux__) && !defined(_GNU_SOURCE)
#define _GNU_SOURCE 1 /* memmem */
#endif
#include "scr_runtime.h"
#include "scr_system_errors.h"

#include <errno.h>
#include <math.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#ifdef _WIN32
#include <winsock2.h> /* BEFORE windows.h (which pulls winsock 1 otherwise) */
#include <windows.h>
#elif !defined(__wasi__)
#include <dlfcn.h>
#include <fcntl.h>
#include <sys/resource.h>
#include <sys/utsname.h>
#include <unistd.h>
#endif
#include <fcntl.h>
#include <sys/stat.h>
#ifdef __linux__
#include <sys/sysinfo.h>
#endif
#ifdef __APPLE__
#include <mach/mach.h>
#include <sys/sysctl.h>
#endif

/* ── shared helpers ─────────────────────────────────────────────────── */

static void scr_os_oom(void) { scr_trap("scriptc: out of memory\n"); }

#ifdef _WIN32
/* UTF-16 to a fresh UTF-8 string (n units, or NUL-terminated when n < 0). */
static ScrStr *scr_os_utf16(const WCHAR *text, int n) {
  int bytes = WideCharToMultiByte(CP_UTF8, 0, text, n, NULL, 0, NULL, NULL);
  if (bytes <= 0) return scr_str_new("", 0);
  char *buf = malloc((size_t)bytes);
  if (!buf) scr_os_oom();
  WideCharToMultiByte(CP_UTF8, 0, text, n, buf, bytes, NULL, NULL);
  size_t len = (size_t)bytes;
  if (n < 0 && len > 0) len--; /* the converted NUL */
  ScrStr *out = scr_str_new(buf, len);
  free(buf);
  return out;
}
#endif

#ifdef __linux__
/* libuv's uv__slurp: one read of at most cap - 1 bytes, NUL-terminated. */
static bool scr_os_read_file(const char *path, char *buf, size_t cap) {
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return false;
  ssize_t n;
  do
    n = read(fd, buf, cap - 1);
  while (n < 0 && errno == EINTR);
  close(fd);
  if (n < 0) return false;
  buf[n] = '\0';
  return true;
}
#endif

/* ── uname, hostname, endianness ──────────────────────────────────────
 * Node reads uv_os_uname once at module load; the fields are 256-byte
 * buffers there, so longer values fail rather than truncate. */

#if !defined(_WIN32) && !defined(__wasi__)
static ScrStr *scr_os_uname_field(int which) {
  struct utsname u;
  if (uname(&u) != 0) return scr_str_new("", 0);
  const char *field = which == 0 ? u.machine : u.version;
  size_t len = strlen(field);
  return len < 256 ? scr_str_new(field, len) : scr_str_new("", 0);
}
#endif

ScrStr *scr_os_machine(void) {
#ifdef _WIN32
  /* uv_os_uname's processor-architecture switch; it has no ARM64 case. */
  SYSTEM_INFO info;
  GetSystemInfo(&info);
  switch (info.wProcessorArchitecture) {
  case PROCESSOR_ARCHITECTURE_AMD64: return scr_str_new("x86_64", 6);
  case PROCESSOR_ARCHITECTURE_IA64: return scr_str_new("ia64", 4);
  case PROCESSOR_ARCHITECTURE_INTEL: {
    char machine[5] = "i386";
    if (info.wProcessorLevel > 3) machine[1] = (char)('0' + (info.wProcessorLevel < 6 ? info.wProcessorLevel : 6));
    return scr_str_new(machine, 4);
  }
  case PROCESSOR_ARCHITECTURE_IA32_ON_WIN64: return scr_str_new("i686", 4);
  case PROCESSOR_ARCHITECTURE_ARM: return scr_str_new("arm", 3);
  default: return scr_str_new("unknown", 7);
  }
#elif defined(__wasi__)
  return scr_str_new("wasm32", 6);
#else
  return scr_os_uname_field(0);
#endif
}

ScrStr *scr_os_version(void) {
#ifdef _WIN32
  /* uv_os_uname: the registry ProductName, with Windows 11 builds (>=
   * 22000) relabelled from "Windows 10", then the service pack text. */
  typedef LONG(WINAPI * RtlGetVersionFn)(PRTL_OSVERSIONINFOW);
  RTL_OSVERSIONINFOW info;
  memset(&info, 0, sizeof info);
  info.dwOSVersionInfoSize = sizeof info;
  HMODULE ntdll = GetModuleHandleA("ntdll.dll");
  RtlGetVersionFn get = ntdll ? (RtlGetVersionFn)(void *)GetProcAddress(ntdll, "RtlGetVersion") : NULL;
  if (get) get(&info);
  WCHAR product[256];
  DWORD size = sizeof product;
  HKEY key;
  ScrStr *version = scr_str_new("", 0);
  if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion", 0,
                    KEY_QUERY_VALUE | KEY_WOW64_64KEY, &key) == ERROR_SUCCESS) {
    LSTATUS r = RegGetValueW(key, NULL, L"ProductName", RRF_RT_REG_SZ, NULL, product, &size);
    RegCloseKey(key);
    if (r == ERROR_SUCCESS) {
      if (info.dwMajorVersion == 10 && info.dwBuildNumber >= 22000 && size >= sizeof L"Windows 10" &&
          wcsncmp(product, L"Windows 10", 10) == 0)
        product[9] = L'1';
      scr_str_release(version);
      version = scr_os_utf16(product, -1);
    }
  }
  if (info.szCSDVersion[0] != L'\0') {
    ScrStr *pack = scr_os_utf16(info.szCSDVersion, -1);
    ScrJsonBuf b;
    scr_jb_init(&b);
    scr_jb_put_str(&b, version);
    if (version->len > 0) scr_jb_putc(&b, ' ');
    scr_jb_put_str(&b, pack);
    scr_str_release(pack);
    scr_str_release(version);
    version = scr_jb_finish(&b);
  }
  return version;
#elif defined(__wasi__)
  return scr_str_new("", 0);
#else
  return scr_os_uname_field(1);
#endif
}

ScrStr *scr_os_hostname(void) {
#ifdef _WIN32
  WCHAR buf[257];
  typedef int(WSAAPI * GetHostNameWFn)(PWSTR, int);
  HMODULE ws2 = LoadLibraryA("ws2_32.dll");
  GetHostNameWFn get = ws2 ? (GetHostNameWFn)(void *)GetProcAddress(ws2, "GetHostNameW") : NULL;
  if (get) {
    WSADATA wsa;
    WSAStartup(MAKEWORD(2, 2), &wsa);
    if (get(buf, 257) == 0) return scr_os_utf16(buf, -1);
  }
  return scr_str_new("", 0);
#elif defined(__wasi__)
  return scr_str_new("localhost", 9);
#else
  char buf[257]; /* UV_MAXHOSTNAMESIZE */
  if (gethostname(buf, sizeof buf) != 0) return scr_str_new("", 0);
  buf[sizeof buf - 1] = '\0';
  return scr_str_new(buf, strlen(buf));
#endif
}

ScrStr *scr_os_endianness(void) {
  const uint16_t probe = 1;
  return *(const uint8_t *)&probe ? scr_str_new("LE", 2) : scr_str_new("BE", 2);
}

/* ── memory, uptime, load ───────────────────────────────────────────── */

double scr_os_freemem(void) {
#ifdef _WIN32
  MEMORYSTATUSEX status;
  status.dwLength = sizeof status;
  return GlobalMemoryStatusEx(&status) ? (double)status.ullAvailPhys : 0;
#elif defined(__linux__)
  /* MemAvailable from /proc/meminfo, else sysinfo's free RAM. */
  char buf[4096];
  if (scr_os_read_file("/proc/meminfo", buf, sizeof buf)) {
    const char *p = strstr(buf, "MemAvailable:");
    if (p) {
      unsigned long long kb = 0;
      sscanf(p + 13, "%llu kB", &kb);
      if (kb != 0) return (double)(kb * 1024);
    }
  }
  struct sysinfo info;
  if (sysinfo(&info) == 0) return (double)((unsigned long long)info.freeram * info.mem_unit);
  return 0;
#elif defined(__APPLE__)
  vm_statistics_data_t info;
  mach_msg_type_number_t count = sizeof info / sizeof(integer_t);
  if (host_statistics(mach_host_self(), HOST_VM_INFO, (host_info_t)&info, &count) != KERN_SUCCESS)
    return 0;
  return (double)((uint64_t)info.free_count * (uint64_t)sysconf(_SC_PAGESIZE));
#else
  return 0;
#endif
}

double scr_os_uptime(void) {
#ifdef _WIN32
  return (double)GetTickCount64() / 1000.0;
#elif defined(__linux__)
  /* /proc/uptime's first field (fractional seconds), else CLOCK_BOOTTIME's
   * whole seconds. */
  char buf[128];
  double uptime;
  if (scr_os_read_file("/proc/uptime", buf, sizeof buf) && sscanf(buf, "%lf", &uptime) == 1)
    return uptime;
  struct timespec now;
  if (clock_gettime(CLOCK_BOOTTIME, &now) != 0) return 0;
  return (double)now.tv_sec;
#elif defined(__APPLE__)
  struct timeval boot;
  size_t size = sizeof boot;
  int which[] = { CTL_KERN, KERN_BOOTTIME };
  if (sysctl(which, 2, &boot, &size, NULL, 0) != 0) return 0;
  return (double)(time(NULL) - boot.tv_sec);
#else
  return 0;
#endif
}

ScrArr *scr_os_loadavg(void) {
  double avg[3] = { 0, 0, 0 };
#if defined(__linux__)
  char buf[128];
  if (!scr_os_read_file("/proc/loadavg", buf, sizeof buf) ||
      sscanf(buf, "%lf %lf %lf", &avg[0], &avg[1], &avg[2]) != 3) {
    struct sysinfo info;
    if (sysinfo(&info) == 0) {
      avg[0] = (double)info.loads[0] / 65536.0;
      avg[1] = (double)info.loads[1] / 65536.0;
      avg[2] = (double)info.loads[2] / 65536.0;
    }
  }
#elif defined(__APPLE__)
  struct loadavg info;
  size_t size = sizeof info;
  int which[] = { CTL_VM, VM_LOADAVG };
  if (sysctl(which, 2, &info, &size, NULL, 0) == 0) {
    avg[0] = (double)info.ldavg[0] / info.fscale;
    avg[1] = (double)info.ldavg[1] / info.fscale;
    avg[2] = (double)info.ldavg[2] / info.fscale;
  }
#endif
  ScrArr *out = scr_arr_new(SCR_ELEM_F64, 3);
  for (int i = 0; i < 3; i++) scr_arr_push_f64(out, avg[i]);
  return out;
}

/* ── getPriority ──────────────────────────────────────────────────────
 * validateInt32(pid, 'pid') (an omitted pid is 0 at the call site), then
 * uv_os_getpriority; a failure is Node's ERR_SYSTEM_ERROR. */

enum { SCR_OS_PRIORITY_LOW = 19, SCR_OS_PRIORITY_BELOW_NORMAL = 10, SCR_OS_PRIORITY_NORMAL = 0,
       SCR_OS_PRIORITY_ABOVE_NORMAL = -7, SCR_OS_PRIORITY_HIGH = -14, SCR_OS_PRIORITY_HIGHEST = -20 };

typedef struct { int value; const char *name; const char *message; } ScrOsUvError;
#define SCR_OS_UV_ERROR(name, message) { SCR_NODE_UV__##name, #name, message },
static const ScrOsUvError scr_os_uv_errors[] = { SCR_NODE_UV_ERRNO_MAP(SCR_OS_UV_ERROR) };
#undef SCR_OS_UV_ERROR

static void scr_os_system_error(const char *syscall, int uv_code) {
  const char *name = "UNKNOWN", *message = "unknown error";
  for (size_t i = 0; i < sizeof scr_os_uv_errors / sizeof scr_os_uv_errors[0]; i++) {
    if (scr_os_uv_errors[i].value == uv_code) {
      name = scr_os_uv_errors[i].name;
      message = scr_os_uv_errors[i].message;
      break;
    }
  }
  char text[256];
  int n = snprintf(text, sizeof text, "A system error occurred: %s returned %s (%s)", syscall, name, message);
  ScrStr *msg = scr_str_new(text, n < 0 ? 0 : (size_t)n);
  ScrStr *error_name = scr_str_new("SystemError", 11);
  scr_throw_error_named(error_name, msg);
  ScrExcCell *cell = scr_exc_current_cell();
  if (cell->kind == SCR_EXC_OBJ) scr_error_set_code((ScrError *)cell->payload, "ERR_SYSTEM_ERROR");
}

static bool scr_os_validate_int32_in(const char *name, double value, int min, int max) {
  if (isfinite(value) && trunc(value) == value) {
    if (value >= (double)min && value <= (double)max) return true;
  }
  char received[48];
  scr_num_received(value, received);
  char text[192];
  int n = isfinite(value) && trunc(value) == value
    ? snprintf(text, sizeof text,
               "The value of \"%s\" is out of range. It must be >= %d && <= %d. Received %s",
               name, min, max, received)
    : snprintf(text, sizeof text, "The value of \"%s\" is out of range. It must be an integer. Received %s",
               name, received);
  scr_throw_error_msg_code(SCR_ERR_RANGE, text, n < 0 ? 0 : (size_t)n, "ERR_OUT_OF_RANGE");
  return false;
}

static bool scr_os_validate_int32(const char *name, double value) {
  return scr_os_validate_int32_in(name, value, INT32_MIN, INT32_MAX);
}

double scr_os_get_priority(double pid) {
  if (!scr_os_validate_int32("pid", pid)) return 0;
#ifdef _WIN32
  HANDLE handle = pid == 0 ? GetCurrentProcess()
                           : OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, (DWORD)(int)pid);
  if (handle == NULL) {
    DWORD err = GetLastError();
    scr_os_system_error("uv_os_getpriority", err == ERROR_ACCESS_DENIED ? SCR_NODE_UV__EPERM
                                             : err == ERROR_INVALID_PARAMETER ? SCR_NODE_UV__EINVAL
                                                                              : SCR_NODE_UV__UNKNOWN);
    return 0;
  }
  DWORD klass = GetPriorityClass(handle);
  if (pid != 0) CloseHandle(handle);
  if (klass == 0) {
    scr_os_system_error("uv_os_getpriority", SCR_NODE_UV__UNKNOWN);
    return 0;
  }
  if (klass == REALTIME_PRIORITY_CLASS) return SCR_OS_PRIORITY_HIGHEST;
  if (klass == HIGH_PRIORITY_CLASS) return SCR_OS_PRIORITY_HIGH;
  if (klass == ABOVE_NORMAL_PRIORITY_CLASS) return SCR_OS_PRIORITY_ABOVE_NORMAL;
  if (klass == NORMAL_PRIORITY_CLASS) return SCR_OS_PRIORITY_NORMAL;
  if (klass == BELOW_NORMAL_PRIORITY_CLASS) return SCR_OS_PRIORITY_BELOW_NORMAL;
  return SCR_OS_PRIORITY_LOW;
#elif defined(__wasi__)
  scr_os_system_error("uv_os_getpriority", SCR_NODE_UV__ENOSYS);
  return 0;
#else
  errno = 0;
  int r = getpriority(PRIO_PROCESS, (id_t)(int)pid);
  if (r == -1 && errno != 0) {
    scr_os_system_error("uv_os_getpriority", SCR_NODE_UV__ERR(errno));
    return 0;
  }
  return r;
#endif
}

/* ── setPriority ──────────────────────────────────────────────────────
 * validateInt32(pid, 'pid') and validateInt32(priority, 'priority', -20,
 * 19) (a one-argument call passes pid 0), then uv_os_setpriority; a
 * failure is Node's ERR_SYSTEM_ERROR. */

void scr_os_set_priority(double pid, double priority) {
  if (!scr_os_validate_int32("pid", pid)) return;
  if (!scr_os_validate_int32_in("priority", priority, SCR_OS_PRIORITY_HIGHEST, SCR_OS_PRIORITY_LOW)) return;
  int value = (int)priority;
#ifdef _WIN32
  /* libuv's mapping of nice values to Windows priority classes. */
  DWORD klass = value < SCR_OS_PRIORITY_HIGH           ? REALTIME_PRIORITY_CLASS
                : value < SCR_OS_PRIORITY_ABOVE_NORMAL ? HIGH_PRIORITY_CLASS
                : value < SCR_OS_PRIORITY_NORMAL       ? ABOVE_NORMAL_PRIORITY_CLASS
                : value < SCR_OS_PRIORITY_BELOW_NORMAL ? NORMAL_PRIORITY_CLASS
                : value < SCR_OS_PRIORITY_LOW          ? BELOW_NORMAL_PRIORITY_CLASS
                                                       : IDLE_PRIORITY_CLASS;
  HANDLE handle = pid == 0 ? GetCurrentProcess()
                           : OpenProcess(PROCESS_SET_INFORMATION, FALSE, (DWORD)(int)pid);
  if (handle == NULL) {
    DWORD err = GetLastError();
    scr_os_system_error("uv_os_setpriority", err == ERROR_ACCESS_DENIED ? SCR_NODE_UV__EPERM
                                             : err == ERROR_INVALID_PARAMETER ? SCR_NODE_UV__EINVAL
                                                                              : SCR_NODE_UV__UNKNOWN);
    return;
  }
  BOOL ok = SetPriorityClass(handle, klass);
  DWORD err = ok ? 0 : GetLastError();
  if (pid != 0) CloseHandle(handle);
  if (!ok) {
    scr_os_system_error("uv_os_setpriority", err == ERROR_ACCESS_DENIED ? SCR_NODE_UV__EPERM
                                                                        : SCR_NODE_UV__UNKNOWN);
  }
#elif defined(__wasi__)
  (void)value;
  scr_os_system_error("uv_os_setpriority", SCR_NODE_UV__ENOSYS);
#else
  if (setpriority(PRIO_PROCESS, (id_t)(int)pid, value) != 0)
    scr_os_system_error("uv_os_setpriority", SCR_NODE_UV__ERR(errno));
#endif
}

/* ── cpus ─────────────────────────────────────────────────────────────
 * uv_cpu_info, snapshotted once per os.cpus() call: scr_os_cpus_take
 * reads every CPU and answers the count; the accessors read that
 * snapshot (the compiler builds the CpuInfo records from them). Field k:
 * 0 speed, 1 user, 2 nice, 3 sys, 4 idle, 5 irq. A failed read is the
 * empty list (Node's `getCPUs() || []`). */

typedef struct {
  ScrStr *model;
  double fields[6];
} ScrOsCpu;

static SCR_TL ScrOsCpu *scr_os_cpus;
static SCR_TL size_t scr_os_cpus_len;
static SCR_TL bool scr_os_cpus_armed;

static void scr_os_cpus_clear(void) {
  for (size_t i = 0; i < scr_os_cpus_len; i++) scr_str_release(scr_os_cpus[i].model);
  free(scr_os_cpus);
  scr_os_cpus = NULL;
  scr_os_cpus_len = 0;
}

#if defined(__linux__) || defined(__APPLE__)
/* V8's OneByteString: each byte is one Latin-1 code point. */
static ScrStr *scr_os_latin1(const char *p, size_t n) {
  size_t extra = 0;
  for (size_t i = 0; i < n; i++) extra += (unsigned char)p[i] >= 0x80;
  if (extra == 0) return scr_str_new(p, n);
  char *buf = malloc(n + extra);
  if (!buf) scr_os_oom();
  size_t w = 0;
  for (size_t i = 0; i < n; i++) {
    unsigned char c = (unsigned char)p[i];
    if (c < 0x80) {
      buf[w++] = (char)c;
    } else {
      buf[w++] = (char)(0xC0 | (c >> 6));
      buf[w++] = (char)(0x80 | (c & 0x3F));
    }
  }
  ScrStr *out = scr_str_new(buf, w);
  free(buf);
  return out;
}
#endif

static ScrOsCpu *scr_os_cpus_alloc(size_t n) {
  ScrOsCpu *cpus = calloc(n ? n : 1, sizeof *cpus);
  if (!cpus) scr_os_oom();
  return cpus;
}

#if defined(__linux__)
/* libuv's /proc/cpuinfo model markers, and the arm64 part-number names. */
#if defined(__PPC__)
#define SCR_OS_MODEL_MARKER "cpu\t\t: "
#define SCR_OS_MODEL_MARKER2 ""
#elif defined(__arm__)
#define SCR_OS_MODEL_MARKER "model name\t: "
#define SCR_OS_MODEL_MARKER2 "Processor\t: "
#elif defined(__aarch64__)
#define SCR_OS_MODEL_MARKER "CPU part\t: "
#define SCR_OS_MODEL_MARKER2 ""
#elif defined(__mips__)
#define SCR_OS_MODEL_MARKER "cpu model\t\t: "
#define SCR_OS_MODEL_MARKER2 ""
#elif defined(__loongarch__)
#define SCR_OS_MODEL_MARKER "cpu family\t\t: "
#define SCR_OS_MODEL_MARKER2 ""
#else
#define SCR_OS_MODEL_MARKER "model name\t: "
#define SCR_OS_MODEL_MARKER2 ""
#endif
static const char scr_os_cpu_parts[] =
#ifdef __aarch64__
    "0x811\nARM810\n"       "0x920\nARM920\n"      "0x922\nARM922\n"
    "0x926\nARM926\n"       "0x940\nARM940\n"      "0x946\nARM946\n"
    "0x966\nARM966\n"       "0xa20\nARM1020\n"      "0xa22\nARM1022\n"
    "0xa26\nARM1026\n"      "0xb02\nARM11 MPCore\n" "0xb36\nARM1136\n"
    "0xb56\nARM1156\n"      "0xb76\nARM1176\n"      "0xc05\nCortex-A5\n"
    "0xc07\nCortex-A7\n"    "0xc08\nCortex-A8\n"    "0xc09\nCortex-A9\n"
    "0xc0d\nCortex-A17\n"   /* Originally A12 */
    "0xc0f\nCortex-A15\n"   "0xc0e\nCortex-A17\n"   "0xc14\nCortex-R4\n"
    "0xc15\nCortex-R5\n"    "0xc17\nCortex-R7\n"    "0xc18\nCortex-R8\n"
    "0xc20\nCortex-M0\n"    "0xc21\nCortex-M1\n"    "0xc23\nCortex-M3\n"
    "0xc24\nCortex-M4\n"    "0xc27\nCortex-M7\n"    "0xc60\nCortex-M0+\n"
    "0xd01\nCortex-A32\n"   "0xd03\nCortex-A53\n"   "0xd04\nCortex-A35\n"
    "0xd05\nCortex-A55\n"   "0xd06\nCortex-A65\n"   "0xd07\nCortex-A57\n"
    "0xd08\nCortex-A72\n"   "0xd09\nCortex-A73\n"   "0xd0a\nCortex-A75\n"
    "0xd0b\nCortex-A76\n"   "0xd0c\nNeoverse-N1\n"  "0xd0d\nCortex-A77\n"
    "0xd0e\nCortex-A76AE\n" "0xd13\nCortex-R52\n"   "0xd20\nCortex-M23\n"
    "0xd21\nCortex-M33\n"   "0xd41\nCortex-A78\n"   "0xd42\nCortex-A78AE\n"
    "0xd4a\nNeoverse-E1\n"  "0xd4b\nCortex-A78C\n"
#endif
    "";

static size_t scr_os_cpus_read(ScrOsCpu **out) {
  enum { MAX_CPUS = 8192 };
  struct cpu { unsigned long long freq, user, nice, sys, idle, irq; unsigned model; };
  struct cpu *cpus = calloc(MAX_CPUS, sizeof *cpus);
  unsigned char *bitmap = calloc(MAX_CPUS / 8, 1);
  if (!cpus || !bitmap) scr_os_oom();
  char models[8][64];
  char buf[1024];
  memset(models, 0, sizeof models);
  snprintf(models[0], sizeof models[0], "unknown");
  unsigned maxcpu = 0, cpu;
  size_t n = 0;
  FILE *fp = fopen("/proc/stat", "re");
  if (fp == NULL) goto done;
  if (fgets(buf, sizeof buf, fp) == NULL) {
    fclose(fp);
    goto done;
  }
  for (;;) {
    struct cpu t;
    unsigned long long skip;
    memset(&t, 0, sizeof t);
    if (fscanf(fp, "cpu%u %llu %llu %llu %llu %llu %llu", &cpu, &t.user, &t.nice, &t.sys, &t.idle,
               &skip, &t.irq) != 7)
      break;
    if (fgets(buf, sizeof buf, fp) == NULL) break;
    if (cpu >= MAX_CPUS) continue;
    cpus[cpu] = t;
    bitmap[cpu >> 3] |= (unsigned char)(1 << (cpu & 7));
    if (cpu >= maxcpu) maxcpu = cpu + 1;
  }
  fclose(fp);
  /* Model names: libuv's scan, including its matching rule (a model slot
   * matches when the name starts with its text; the first empty slot
   * matches anything, and the slot after the match is used). */
  fp = fopen("/proc/cpuinfo", "re");
  if (fp != NULL) {
    for (;;) {
      if (fscanf(fp, "processor\t: %u\n", &cpu) != 1) break;
      const char *p = NULL;
      while (fgets(buf, sizeof buf, fp)) {
        if (!strncmp(buf, SCR_OS_MODEL_MARKER, sizeof SCR_OS_MODEL_MARKER - 1)) {
          p = buf + sizeof SCR_OS_MODEL_MARKER - 1;
          break;
        }
        if (!*SCR_OS_MODEL_MARKER2) continue;
        if (!strncmp(buf, SCR_OS_MODEL_MARKER2, sizeof SCR_OS_MODEL_MARKER2 - 1)) {
          p = buf + sizeof SCR_OS_MODEL_MARKER2 - 1;
          break;
        }
      }
      if (p != NULL) {
        int len = (int)strcspn(p, "\n");
        if (*scr_os_cpu_parts) {
          const char *hit = memmem(scr_os_cpu_parts, sizeof scr_os_cpu_parts - 1, p, (size_t)len + 1);
          p = hit == NULL ? "unknown" : hit + len + 1;
          len = (int)strcspn(p, "\n");
        }
        int found = 0;
        char (*model)[64];
        for (model = models; !found && model < models + 8; model++)
          found = !strncmp(p, *model, strlen(*model));
        if (found) {
          if (**model == '\0') snprintf(*model, sizeof *model, "%.*s", len, p);
          if (cpu < maxcpu) cpus[cpu].model = (unsigned)(model - models);
        }
      }
      while (fgets(buf, sizeof buf, fp))
        if (*buf == '\n') break;
    }
    fclose(fp);
  }
  for (cpu = 0; cpu < maxcpu; cpu++) {
    if (!(bitmap[cpu >> 3] & (1 << (cpu & 7)))) continue;
    n++;
    snprintf(buf, sizeof buf, "/sys/devices/system/cpu/cpu%u/cpufreq/scaling_cur_freq", cpu);
    fp = fopen(buf, "re");
    if (fp == NULL) continue;
    if (fscanf(fp, "%llu", &cpus[cpu].freq) != 1) cpus[cpu].freq = 0;
    fclose(fp);
  }
  *out = scr_os_cpus_alloc(n);
  size_t i = 0;
  for (cpu = 0; cpu < maxcpu; cpu++) {
    if (!(bitmap[cpu >> 3] & (1 << (cpu & 7)))) continue;
    const struct cpu *c = &cpus[cpu];
    const char *name = c->model < 8 ? models[c->model] : models[0];
    (*out)[i].model = scr_os_latin1(name, strlen(name));
    (*out)[i].fields[0] = (double)(c->freq / 1000);
    /* sysconf(_SC_CLK_TCK) is fixed at 100: the multiplier is always 10. */
    (*out)[i].fields[1] = (double)(10 * c->user);
    (*out)[i].fields[2] = (double)(10 * c->nice);
    (*out)[i].fields[3] = (double)(10 * c->sys);
    (*out)[i].fields[4] = (double)(10 * c->idle);
    (*out)[i].fields[5] = (double)(10 * c->irq);
    i++;
  }
done:
  free(cpus);
  free(bitmap);
  return n;
}
#elif defined(__APPLE__)
static size_t scr_os_cpus_read(ScrOsCpu **out) {
  unsigned ticks = (unsigned)sysconf(_SC_CLK_TCK);
  uint64_t multiplier = (uint64_t)1000L / ticks;
  char model[512];
  size_t size = sizeof model;
  if (sysctlbyname("machdep.cpu.brand_string", &model, &size, NULL, 0) &&
      sysctlbyname("hw.model", &model, &size, NULL, 0))
    return 0;
  uint64_t speed = 0;
  size = sizeof speed;
  sysctlbyname("hw.cpufrequency", &speed, &size, NULL, 0);
  if (speed == 0) speed = 2400000000U;
  natural_t count;
  mach_msg_type_number_t msg_type;
  processor_cpu_load_info_data_t *info;
  if (host_processor_info(mach_host_self(), PROCESSOR_CPU_LOAD_INFO, &count,
                          (processor_info_array_t *)&info, &msg_type) != KERN_SUCCESS)
    return 0;
  *out = scr_os_cpus_alloc(count);
  for (natural_t i = 0; i < count; i++) {
    (*out)[i].model = scr_os_latin1(model, strlen(model));
    (*out)[i].fields[0] = (double)(int)(speed / 1000000);
    (*out)[i].fields[1] = (double)((uint64_t)info[i].cpu_ticks[0] * multiplier);
    (*out)[i].fields[2] = (double)((uint64_t)info[i].cpu_ticks[3] * multiplier);
    (*out)[i].fields[3] = (double)((uint64_t)info[i].cpu_ticks[1] * multiplier);
    (*out)[i].fields[4] = (double)((uint64_t)info[i].cpu_ticks[2] * multiplier);
    (*out)[i].fields[5] = 0;
  }
  vm_deallocate(mach_task_self(), (vm_address_t)info, msg_type);
  return count;
}
#elif defined(_WIN32)
typedef struct {
  LARGE_INTEGER IdleTime;
  LARGE_INTEGER KernelTime;
  LARGE_INTEGER UserTime;
  LARGE_INTEGER DpcTime;
  LARGE_INTEGER InterruptTime;
  ULONG InterruptCount;
} ScrOsProcessorTimes;

static size_t scr_os_cpus_read(ScrOsCpu **out) {
  typedef LONG(NTAPI * QueryFn)(int, PVOID, ULONG, PULONG);
  HMODULE ntdll = GetModuleHandleA("ntdll.dll");
  QueryFn query = ntdll ? (QueryFn)(void *)GetProcAddress(ntdll, "NtQuerySystemInformation") : NULL;
  if (query == NULL) return 0;
  SYSTEM_INFO system;
  GetSystemInfo(&system);
  DWORD count = system.dwNumberOfProcessors;
  ScrOsProcessorTimes *times = calloc(count ? count : 1, sizeof *times);
  if (!times) scr_os_oom();
  ULONG got = 0;
  /* SystemProcessorPerformanceInformation */
  if (query(8, times, (ULONG)(count * sizeof *times), &got) < 0) {
    free(times);
    return 0;
  }
  ScrOsCpu *cpus = scr_os_cpus_alloc(count);
  for (DWORD i = 0; i < count; i++) {
    WCHAR key_name[128];
    _snwprintf(key_name, 128, L"HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\%d", (int)i);
    HKEY key;
    DWORD speed = 0, speed_size = sizeof speed;
    WCHAR brand[256];
    DWORD brand_size = sizeof brand;
    bool ok = RegOpenKeyExW(HKEY_LOCAL_MACHINE, key_name, 0, KEY_QUERY_VALUE, &key) == ERROR_SUCCESS;
    if (ok) {
      ok = RegQueryValueExW(key, L"~MHz", NULL, NULL, (BYTE *)&speed, &speed_size) == ERROR_SUCCESS &&
           RegQueryValueExW(key, L"ProcessorNameString", NULL, NULL, (BYTE *)brand, &brand_size) == ERROR_SUCCESS;
      RegCloseKey(key);
    }
    if (!ok) {
      for (DWORD j = 0; j < i; j++) scr_str_release(cpus[j].model);
      free(cpus);
      free(times);
      return 0;
    }
    cpus[i].model = scr_os_utf16(brand, (int)(brand_size / sizeof(WCHAR)));
    if (cpus[i].model->len > 0 && cpus[i].model->data[cpus[i].model->len - 1] == '\0') {
      ScrStr *trimmed = scr_str_new(cpus[i].model->data, cpus[i].model->len - 1);
      scr_str_release(cpus[i].model);
      cpus[i].model = trimmed;
    }
    cpus[i].fields[0] = (double)speed;
    cpus[i].fields[1] = (double)(times[i].UserTime.QuadPart / 10000);
    cpus[i].fields[2] = 0;
    cpus[i].fields[3] = (double)((times[i].KernelTime.QuadPart - times[i].IdleTime.QuadPart) / 10000);
    cpus[i].fields[4] = (double)(times[i].IdleTime.QuadPart / 10000);
    cpus[i].fields[5] = (double)(times[i].InterruptTime.QuadPart / 10000);
  }
  free(times);
  *out = cpus;
  return count;
}
#else
static size_t scr_os_cpus_read(ScrOsCpu **out) {
  *out = scr_os_cpus_alloc(0);
  return 0;
}
#endif

double scr_os_cpus_take(void) {
  scr_os_cpus_clear();
  if (!scr_os_cpus_armed) {
    scr_os_cpus_armed = true;
    scr_atexit(scr_os_cpus_clear);
  }
  ScrOsCpu *cpus = NULL;
  size_t n = scr_os_cpus_read(&cpus);
  scr_os_cpus = cpus;
  scr_os_cpus_len = cpus ? n : 0;
  return (double)scr_os_cpus_len;
}

ScrStr *scr_os_cpus_model(double i) {
  size_t k = (size_t)i;
  return k < scr_os_cpus_len ? scr_str_retain(scr_os_cpus[k].model) : scr_str_new("", 0);
}

double scr_os_cpus_field(double i, double field) {
  size_t k = (size_t)i, f = (size_t)field;
  return k < scr_os_cpus_len && f < 6 ? scr_os_cpus[k].fields[f] : 0;
}

/* ── constants ────────────────────────────────────────────────────────
 * internalBinding('constants').os: null-prototype objects whose numeric
 * members are read-only and non-configurable, in node_constants.cc's
 * order and with its #ifdef guards over the platform headers; libuv
 * supplies the priority values and, on Windows, SIGHUP/SIGKILL/SIGWINCH.
 * lib/os.js freezes `signals`. One object per thread: os.constants is
 * the same value on every read. */

#ifdef _WIN32
#ifndef SIGHUP
#define SIGHUP 1
#endif
#ifndef SIGKILL
#define SIGKILL 9
#endif
#ifndef SIGWINCH
#define SIGWINCH 28
#endif
#endif

static void scr_os_constant(ScrDyn *o, const char *name, double value) {
  scr_dyn_obj_set(o, name, strlen(name), scr_dyn_new_num(value));
  size_t last = scr_dyn_obj_count(o) - 1;
  scr_dyn_obj_set_attrs_at(o, last, false, scr_dyn_obj_prop_at(o, last).enumerable, false);
}
#define SCR_OS_CONSTANT(o, name) scr_os_constant((o), #name, (double)(name))

static void scr_os_errno_constants(ScrDyn *o) {
#ifdef E2BIG
  SCR_OS_CONSTANT(o, E2BIG);
#endif
#ifdef EACCES
  SCR_OS_CONSTANT(o, EACCES);
#endif
#ifdef EADDRINUSE
  SCR_OS_CONSTANT(o, EADDRINUSE);
#endif
#ifdef EADDRNOTAVAIL
  SCR_OS_CONSTANT(o, EADDRNOTAVAIL);
#endif
#ifdef EAFNOSUPPORT
  SCR_OS_CONSTANT(o, EAFNOSUPPORT);
#endif
#ifdef EAGAIN
  SCR_OS_CONSTANT(o, EAGAIN);
#endif
#ifdef EALREADY
  SCR_OS_CONSTANT(o, EALREADY);
#endif
#ifdef EBADF
  SCR_OS_CONSTANT(o, EBADF);
#endif
#ifdef EBADMSG
  SCR_OS_CONSTANT(o, EBADMSG);
#endif
#ifdef EBUSY
  SCR_OS_CONSTANT(o, EBUSY);
#endif
#ifdef ECANCELED
  SCR_OS_CONSTANT(o, ECANCELED);
#endif
#ifdef ECHILD
  SCR_OS_CONSTANT(o, ECHILD);
#endif
#ifdef ECONNABORTED
  SCR_OS_CONSTANT(o, ECONNABORTED);
#endif
#ifdef ECONNREFUSED
  SCR_OS_CONSTANT(o, ECONNREFUSED);
#endif
#ifdef ECONNRESET
  SCR_OS_CONSTANT(o, ECONNRESET);
#endif
#ifdef EDEADLK
  SCR_OS_CONSTANT(o, EDEADLK);
#endif
#ifdef EDESTADDRREQ
  SCR_OS_CONSTANT(o, EDESTADDRREQ);
#endif
#ifdef EDOM
  SCR_OS_CONSTANT(o, EDOM);
#endif
#ifdef EDQUOT
  SCR_OS_CONSTANT(o, EDQUOT);
#endif
#ifdef EEXIST
  SCR_OS_CONSTANT(o, EEXIST);
#endif
#ifdef EFAULT
  SCR_OS_CONSTANT(o, EFAULT);
#endif
#ifdef EFBIG
  SCR_OS_CONSTANT(o, EFBIG);
#endif
#ifdef EHOSTUNREACH
  SCR_OS_CONSTANT(o, EHOSTUNREACH);
#endif
#ifdef EIDRM
  SCR_OS_CONSTANT(o, EIDRM);
#endif
#ifdef EILSEQ
  SCR_OS_CONSTANT(o, EILSEQ);
#endif
#ifdef EINPROGRESS
  SCR_OS_CONSTANT(o, EINPROGRESS);
#endif
#ifdef EINTR
  SCR_OS_CONSTANT(o, EINTR);
#endif
#ifdef EINVAL
  SCR_OS_CONSTANT(o, EINVAL);
#endif
#ifdef EIO
  SCR_OS_CONSTANT(o, EIO);
#endif
#ifdef EISCONN
  SCR_OS_CONSTANT(o, EISCONN);
#endif
#ifdef EISDIR
  SCR_OS_CONSTANT(o, EISDIR);
#endif
#ifdef ELOOP
  SCR_OS_CONSTANT(o, ELOOP);
#endif
#ifdef EMFILE
  SCR_OS_CONSTANT(o, EMFILE);
#endif
#ifdef EMLINK
  SCR_OS_CONSTANT(o, EMLINK);
#endif
#ifdef EMSGSIZE
  SCR_OS_CONSTANT(o, EMSGSIZE);
#endif
#ifdef EMULTIHOP
  SCR_OS_CONSTANT(o, EMULTIHOP);
#endif
#ifdef ENAMETOOLONG
  SCR_OS_CONSTANT(o, ENAMETOOLONG);
#endif
#ifdef ENETDOWN
  SCR_OS_CONSTANT(o, ENETDOWN);
#endif
#ifdef ENETRESET
  SCR_OS_CONSTANT(o, ENETRESET);
#endif
#ifdef ENETUNREACH
  SCR_OS_CONSTANT(o, ENETUNREACH);
#endif
#ifdef ENFILE
  SCR_OS_CONSTANT(o, ENFILE);
#endif
#ifdef ENOBUFS
  SCR_OS_CONSTANT(o, ENOBUFS);
#endif
#ifdef ENODATA
  SCR_OS_CONSTANT(o, ENODATA);
#endif
#ifdef ENODEV
  SCR_OS_CONSTANT(o, ENODEV);
#endif
#ifdef ENOENT
  SCR_OS_CONSTANT(o, ENOENT);
#endif
#ifdef ENOEXEC
  SCR_OS_CONSTANT(o, ENOEXEC);
#endif
#ifdef ENOLCK
  SCR_OS_CONSTANT(o, ENOLCK);
#endif
#ifdef ENOLINK
  SCR_OS_CONSTANT(o, ENOLINK);
#endif
#ifdef ENOMEM
  SCR_OS_CONSTANT(o, ENOMEM);
#endif
#ifdef ENOMSG
  SCR_OS_CONSTANT(o, ENOMSG);
#endif
#ifdef ENOPROTOOPT
  SCR_OS_CONSTANT(o, ENOPROTOOPT);
#endif
#ifdef ENOSPC
  SCR_OS_CONSTANT(o, ENOSPC);
#endif
#ifdef ENOSR
  SCR_OS_CONSTANT(o, ENOSR);
#endif
#ifdef ENOSTR
  SCR_OS_CONSTANT(o, ENOSTR);
#endif
#ifdef ENOSYS
  SCR_OS_CONSTANT(o, ENOSYS);
#endif
#ifdef ENOTCONN
  SCR_OS_CONSTANT(o, ENOTCONN);
#endif
#ifdef ENOTDIR
  SCR_OS_CONSTANT(o, ENOTDIR);
#endif
#ifdef ENOTEMPTY
  SCR_OS_CONSTANT(o, ENOTEMPTY);
#endif
#ifdef ENOTSOCK
  SCR_OS_CONSTANT(o, ENOTSOCK);
#endif
#ifdef ENOTSUP
  SCR_OS_CONSTANT(o, ENOTSUP);
#endif
#ifdef ENOTTY
  SCR_OS_CONSTANT(o, ENOTTY);
#endif
#ifdef ENXIO
  SCR_OS_CONSTANT(o, ENXIO);
#endif
#ifdef EOPNOTSUPP
  SCR_OS_CONSTANT(o, EOPNOTSUPP);
#endif
#ifdef EOVERFLOW
  SCR_OS_CONSTANT(o, EOVERFLOW);
#endif
#ifdef EPERM
  SCR_OS_CONSTANT(o, EPERM);
#endif
#ifdef EPIPE
  SCR_OS_CONSTANT(o, EPIPE);
#endif
#ifdef EPROTO
  SCR_OS_CONSTANT(o, EPROTO);
#endif
#ifdef EPROTONOSUPPORT
  SCR_OS_CONSTANT(o, EPROTONOSUPPORT);
#endif
#ifdef EPROTOTYPE
  SCR_OS_CONSTANT(o, EPROTOTYPE);
#endif
#ifdef ERANGE
  SCR_OS_CONSTANT(o, ERANGE);
#endif
#ifdef EROFS
  SCR_OS_CONSTANT(o, EROFS);
#endif
#ifdef ESPIPE
  SCR_OS_CONSTANT(o, ESPIPE);
#endif
#ifdef ESRCH
  SCR_OS_CONSTANT(o, ESRCH);
#endif
#ifdef ESTALE
  SCR_OS_CONSTANT(o, ESTALE);
#endif
#ifdef ETIME
  SCR_OS_CONSTANT(o, ETIME);
#endif
#ifdef ETIMEDOUT
  SCR_OS_CONSTANT(o, ETIMEDOUT);
#endif
#ifdef ETXTBSY
  SCR_OS_CONSTANT(o, ETXTBSY);
#endif
#ifdef EWOULDBLOCK
  SCR_OS_CONSTANT(o, EWOULDBLOCK);
#endif
#ifdef EXDEV
  SCR_OS_CONSTANT(o, EXDEV);
#endif
#ifdef WSAEINTR
  SCR_OS_CONSTANT(o, WSAEINTR);
#endif
#ifdef WSAEBADF
  SCR_OS_CONSTANT(o, WSAEBADF);
#endif
#ifdef WSAEACCES
  SCR_OS_CONSTANT(o, WSAEACCES);
#endif
#ifdef WSAEFAULT
  SCR_OS_CONSTANT(o, WSAEFAULT);
#endif
#ifdef WSAEINVAL
  SCR_OS_CONSTANT(o, WSAEINVAL);
#endif
#ifdef WSAEMFILE
  SCR_OS_CONSTANT(o, WSAEMFILE);
#endif
#ifdef WSAEWOULDBLOCK
  SCR_OS_CONSTANT(o, WSAEWOULDBLOCK);
#endif
#ifdef WSAEINPROGRESS
  SCR_OS_CONSTANT(o, WSAEINPROGRESS);
#endif
#ifdef WSAEALREADY
  SCR_OS_CONSTANT(o, WSAEALREADY);
#endif
#ifdef WSAENOTSOCK
  SCR_OS_CONSTANT(o, WSAENOTSOCK);
#endif
#ifdef WSAEDESTADDRREQ
  SCR_OS_CONSTANT(o, WSAEDESTADDRREQ);
#endif
#ifdef WSAEMSGSIZE
  SCR_OS_CONSTANT(o, WSAEMSGSIZE);
#endif
#ifdef WSAEPROTOTYPE
  SCR_OS_CONSTANT(o, WSAEPROTOTYPE);
#endif
#ifdef WSAENOPROTOOPT
  SCR_OS_CONSTANT(o, WSAENOPROTOOPT);
#endif
#ifdef WSAEPROTONOSUPPORT
  SCR_OS_CONSTANT(o, WSAEPROTONOSUPPORT);
#endif
#ifdef WSAESOCKTNOSUPPORT
  SCR_OS_CONSTANT(o, WSAESOCKTNOSUPPORT);
#endif
#ifdef WSAEOPNOTSUPP
  SCR_OS_CONSTANT(o, WSAEOPNOTSUPP);
#endif
#ifdef WSAEPFNOSUPPORT
  SCR_OS_CONSTANT(o, WSAEPFNOSUPPORT);
#endif
#ifdef WSAEAFNOSUPPORT
  SCR_OS_CONSTANT(o, WSAEAFNOSUPPORT);
#endif
#ifdef WSAEADDRINUSE
  SCR_OS_CONSTANT(o, WSAEADDRINUSE);
#endif
#ifdef WSAEADDRNOTAVAIL
  SCR_OS_CONSTANT(o, WSAEADDRNOTAVAIL);
#endif
#ifdef WSAENETDOWN
  SCR_OS_CONSTANT(o, WSAENETDOWN);
#endif
#ifdef WSAENETUNREACH
  SCR_OS_CONSTANT(o, WSAENETUNREACH);
#endif
#ifdef WSAENETRESET
  SCR_OS_CONSTANT(o, WSAENETRESET);
#endif
#ifdef WSAECONNABORTED
  SCR_OS_CONSTANT(o, WSAECONNABORTED);
#endif
#ifdef WSAECONNRESET
  SCR_OS_CONSTANT(o, WSAECONNRESET);
#endif
#ifdef WSAENOBUFS
  SCR_OS_CONSTANT(o, WSAENOBUFS);
#endif
#ifdef WSAEISCONN
  SCR_OS_CONSTANT(o, WSAEISCONN);
#endif
#ifdef WSAENOTCONN
  SCR_OS_CONSTANT(o, WSAENOTCONN);
#endif
#ifdef WSAESHUTDOWN
  SCR_OS_CONSTANT(o, WSAESHUTDOWN);
#endif
#ifdef WSAETOOMANYREFS
  SCR_OS_CONSTANT(o, WSAETOOMANYREFS);
#endif
#ifdef WSAETIMEDOUT
  SCR_OS_CONSTANT(o, WSAETIMEDOUT);
#endif
#ifdef WSAECONNREFUSED
  SCR_OS_CONSTANT(o, WSAECONNREFUSED);
#endif
#ifdef WSAELOOP
  SCR_OS_CONSTANT(o, WSAELOOP);
#endif
#ifdef WSAENAMETOOLONG
  SCR_OS_CONSTANT(o, WSAENAMETOOLONG);
#endif
#ifdef WSAEHOSTDOWN
  SCR_OS_CONSTANT(o, WSAEHOSTDOWN);
#endif
#ifdef WSAEHOSTUNREACH
  SCR_OS_CONSTANT(o, WSAEHOSTUNREACH);
#endif
#ifdef WSAENOTEMPTY
  SCR_OS_CONSTANT(o, WSAENOTEMPTY);
#endif
#ifdef WSAEPROCLIM
  SCR_OS_CONSTANT(o, WSAEPROCLIM);
#endif
#ifdef WSAEUSERS
  SCR_OS_CONSTANT(o, WSAEUSERS);
#endif
#ifdef WSAEDQUOT
  SCR_OS_CONSTANT(o, WSAEDQUOT);
#endif
#ifdef WSAESTALE
  SCR_OS_CONSTANT(o, WSAESTALE);
#endif
#ifdef WSAEREMOTE
  SCR_OS_CONSTANT(o, WSAEREMOTE);
#endif
#ifdef WSASYSNOTREADY
  SCR_OS_CONSTANT(o, WSASYSNOTREADY);
#endif
#ifdef WSAVERNOTSUPPORTED
  SCR_OS_CONSTANT(o, WSAVERNOTSUPPORTED);
#endif
#ifdef WSANOTINITIALISED
  SCR_OS_CONSTANT(o, WSANOTINITIALISED);
#endif
#ifdef WSAEDISCON
  SCR_OS_CONSTANT(o, WSAEDISCON);
#endif
#ifdef WSAENOMORE
  SCR_OS_CONSTANT(o, WSAENOMORE);
#endif
#ifdef WSAECANCELLED
  SCR_OS_CONSTANT(o, WSAECANCELLED);
#endif
#ifdef WSAEINVALIDPROCTABLE
  SCR_OS_CONSTANT(o, WSAEINVALIDPROCTABLE);
#endif
#ifdef WSAEINVALIDPROVIDER
  SCR_OS_CONSTANT(o, WSAEINVALIDPROVIDER);
#endif
#ifdef WSAEPROVIDERFAILEDINIT
  SCR_OS_CONSTANT(o, WSAEPROVIDERFAILEDINIT);
#endif
#ifdef WSASYSCALLFAILURE
  SCR_OS_CONSTANT(o, WSASYSCALLFAILURE);
#endif
#ifdef WSASERVICE_NOT_FOUND
  SCR_OS_CONSTANT(o, WSASERVICE_NOT_FOUND);
#endif
#ifdef WSATYPE_NOT_FOUND
  SCR_OS_CONSTANT(o, WSATYPE_NOT_FOUND);
#endif
#ifdef WSA_E_NO_MORE
  SCR_OS_CONSTANT(o, WSA_E_NO_MORE);
#endif
#ifdef WSA_E_CANCELLED
  SCR_OS_CONSTANT(o, WSA_E_CANCELLED);
#endif
#ifdef WSAEREFUSED
  SCR_OS_CONSTANT(o, WSAEREFUSED);
#endif
}

static void scr_os_signal_constants(ScrDyn *o) {
#ifdef SIGHUP
  SCR_OS_CONSTANT(o, SIGHUP);
#endif
#ifdef SIGINT
  SCR_OS_CONSTANT(o, SIGINT);
#endif
#ifdef SIGQUIT
  SCR_OS_CONSTANT(o, SIGQUIT);
#endif
#ifdef SIGILL
  SCR_OS_CONSTANT(o, SIGILL);
#endif
#ifdef SIGTRAP
  SCR_OS_CONSTANT(o, SIGTRAP);
#endif
#ifdef SIGABRT
  SCR_OS_CONSTANT(o, SIGABRT);
#endif
#ifdef SIGIOT
  SCR_OS_CONSTANT(o, SIGIOT);
#endif
#ifdef SIGBUS
  SCR_OS_CONSTANT(o, SIGBUS);
#endif
#ifdef SIGFPE
  SCR_OS_CONSTANT(o, SIGFPE);
#endif
#ifdef SIGKILL
  SCR_OS_CONSTANT(o, SIGKILL);
#endif
#ifdef SIGUSR1
  SCR_OS_CONSTANT(o, SIGUSR1);
#endif
#ifdef SIGSEGV
  SCR_OS_CONSTANT(o, SIGSEGV);
#endif
#ifdef SIGUSR2
  SCR_OS_CONSTANT(o, SIGUSR2);
#endif
#ifdef SIGPIPE
  SCR_OS_CONSTANT(o, SIGPIPE);
#endif
#ifdef SIGALRM
  SCR_OS_CONSTANT(o, SIGALRM);
#endif
#ifdef SIGTERM
  SCR_OS_CONSTANT(o, SIGTERM);
#endif
#ifdef SIGCHLD
  SCR_OS_CONSTANT(o, SIGCHLD);
#endif
#ifdef SIGSTKFLT
  SCR_OS_CONSTANT(o, SIGSTKFLT);
#endif
#ifdef SIGCONT
  SCR_OS_CONSTANT(o, SIGCONT);
#endif
#ifdef SIGSTOP
  SCR_OS_CONSTANT(o, SIGSTOP);
#endif
#ifdef SIGTSTP
  SCR_OS_CONSTANT(o, SIGTSTP);
#endif
#ifdef SIGBREAK
  SCR_OS_CONSTANT(o, SIGBREAK);
#endif
#ifdef SIGTTIN
  SCR_OS_CONSTANT(o, SIGTTIN);
#endif
#ifdef SIGTTOU
  SCR_OS_CONSTANT(o, SIGTTOU);
#endif
#ifdef SIGURG
  SCR_OS_CONSTANT(o, SIGURG);
#endif
#ifdef SIGXCPU
  SCR_OS_CONSTANT(o, SIGXCPU);
#endif
#ifdef SIGXFSZ
  SCR_OS_CONSTANT(o, SIGXFSZ);
#endif
#ifdef SIGVTALRM
  SCR_OS_CONSTANT(o, SIGVTALRM);
#endif
#ifdef SIGPROF
  SCR_OS_CONSTANT(o, SIGPROF);
#endif
#ifdef SIGWINCH
  SCR_OS_CONSTANT(o, SIGWINCH);
#endif
#ifdef SIGIO
  SCR_OS_CONSTANT(o, SIGIO);
#endif
#ifdef SIGPOLL
  SCR_OS_CONSTANT(o, SIGPOLL);
#endif
#ifdef SIGLOST
  SCR_OS_CONSTANT(o, SIGLOST);
#endif
#ifdef SIGPWR
  SCR_OS_CONSTANT(o, SIGPWR);
#endif
#ifdef SIGINFO
  SCR_OS_CONSTANT(o, SIGINFO);
#endif
#ifdef SIGSYS
  SCR_OS_CONSTANT(o, SIGSYS);
#endif
#ifdef SIGUNUSED
  SCR_OS_CONSTANT(o, SIGUNUSED);
#endif
}

static void scr_os_dlopen_constants(ScrDyn *o) {
#if !defined(_WIN32) && !defined(__wasi__)
#ifdef RTLD_LAZY
  SCR_OS_CONSTANT(o, RTLD_LAZY);
#endif
#ifdef RTLD_NOW
  SCR_OS_CONSTANT(o, RTLD_NOW);
#endif
#ifdef RTLD_GLOBAL
  SCR_OS_CONSTANT(o, RTLD_GLOBAL);
#endif
#ifdef RTLD_LOCAL
  SCR_OS_CONSTANT(o, RTLD_LOCAL);
#endif
#ifdef RTLD_DEEPBIND
  SCR_OS_CONSTANT(o, RTLD_DEEPBIND);
#endif
#else
  (void)o;
#endif
}

static SCR_TL ScrDyn *scr_os_constants_value;
static void scr_os_constants_clear(void) {
  ScrDyn *value = scr_os_constants_value;
  scr_os_constants_value = NULL;
  scr_dyn_release(value);
}

ScrDyn *scr_os_constants(void) {
  if (scr_os_constants_value) return scr_dyn_retain(scr_os_constants_value);
  ScrDyn *os = scr_dyn_new_obj_null_proto();
  ScrDyn *dlopen = scr_dyn_new_obj_null_proto();
  ScrDyn *errnos = scr_dyn_new_obj_null_proto();
  ScrDyn *signals = scr_dyn_new_obj_null_proto();
  ScrDyn *priority = scr_dyn_new_obj_null_proto();
  scr_os_errno_constants(errnos);
  scr_os_signal_constants(signals);
  scr_os_constant(priority, "PRIORITY_LOW", SCR_OS_PRIORITY_LOW);
  scr_os_constant(priority, "PRIORITY_BELOW_NORMAL", SCR_OS_PRIORITY_BELOW_NORMAL);
  scr_os_constant(priority, "PRIORITY_NORMAL", SCR_OS_PRIORITY_NORMAL);
  scr_os_constant(priority, "PRIORITY_ABOVE_NORMAL", SCR_OS_PRIORITY_ABOVE_NORMAL);
  scr_os_constant(priority, "PRIORITY_HIGH", SCR_OS_PRIORITY_HIGH);
  scr_os_constant(priority, "PRIORITY_HIGHEST", SCR_OS_PRIORITY_HIGHEST);
  scr_os_dlopen_constants(dlopen);
  scr_os_constant(os, "UV_UDP_REUSEADDR", 4);
  scr_dyn_obj_set(os, "dlopen", 6, dlopen);
  scr_dyn_obj_set(os, "errno", 5, errnos);
  scr_dyn_release(scr_dyn_freeze_data(signals));
  scr_dyn_obj_set(os, "signals", 7, signals);
  scr_dyn_obj_set(os, "priority", 8, priority);
  scr_os_constants_value = os;
  scr_atexit(scr_os_constants_clear);
  return scr_dyn_retain(os);
}

/* ── node:constants (deprecated, DEP0008) ──────────────────────────────
 * Node's lib/constants.js: Object.assign({}, os.constants.dlopen, errno,
 * priority, signals, fs.constants, crypto.constants), frozen, with an
 * ordinary prototype. The fs group follows node_constants.cc's
 * DefineFsConstants order and guards (libuv's UV_* values are fixed on
 * POSIX); crypto_table (borrowed) is a compiler-emitted function that
 * answers the baked crypto.constants table, called only on first use. One
 * object per thread. */
#define SCR_FS_CONSTANT(o, name) scr_os_constant((o), #name, (double)(name))

static void scr_fs_constants(ScrDyn *o) {
  scr_os_constant(o, "UV_FS_SYMLINK_DIR", 1);
  scr_os_constant(o, "UV_FS_SYMLINK_JUNCTION", 2);
#ifdef O_RDONLY
  SCR_FS_CONSTANT(o, O_RDONLY);
#endif
#ifdef O_WRONLY
  SCR_FS_CONSTANT(o, O_WRONLY);
#endif
#ifdef O_RDWR
  SCR_FS_CONSTANT(o, O_RDWR);
#endif
  scr_os_constant(o, "UV_DIRENT_UNKNOWN", 0);
  scr_os_constant(o, "UV_DIRENT_FILE", 1);
  scr_os_constant(o, "UV_DIRENT_DIR", 2);
  scr_os_constant(o, "UV_DIRENT_LINK", 3);
  scr_os_constant(o, "UV_DIRENT_FIFO", 4);
  scr_os_constant(o, "UV_DIRENT_SOCKET", 5);
  scr_os_constant(o, "UV_DIRENT_CHAR", 6);
  scr_os_constant(o, "UV_DIRENT_BLOCK", 7);
#ifdef S_IFMT
  SCR_FS_CONSTANT(o, S_IFMT);
#endif
#ifdef S_IFREG
  SCR_FS_CONSTANT(o, S_IFREG);
#endif
#ifdef S_IFDIR
  SCR_FS_CONSTANT(o, S_IFDIR);
#endif
#ifdef S_IFCHR
  SCR_FS_CONSTANT(o, S_IFCHR);
#endif
#ifdef S_IFBLK
  SCR_FS_CONSTANT(o, S_IFBLK);
#endif
#ifdef S_IFIFO
  SCR_FS_CONSTANT(o, S_IFIFO);
#endif
#ifdef S_IFLNK
  SCR_FS_CONSTANT(o, S_IFLNK);
#endif
#ifdef S_IFSOCK
  SCR_FS_CONSTANT(o, S_IFSOCK);
#endif
#ifdef O_CREAT
  SCR_FS_CONSTANT(o, O_CREAT);
#endif
#ifdef O_EXCL
  SCR_FS_CONSTANT(o, O_EXCL);
#endif
  /* libuv's Windows-only open flags are 0 everywhere else. */
  scr_os_constant(o, "UV_FS_O_FILEMAP", 0);
  scr_os_constant(o, "UV_FS_O_TEMPORARY", 0);
  scr_os_constant(o, "UV_FS_O_SHORT_LIVED", 0);
  scr_os_constant(o, "UV_FS_O_SEQUENTIAL", 0);
  scr_os_constant(o, "UV_FS_O_RANDOM", 0);
#ifdef O_NOCTTY
  SCR_FS_CONSTANT(o, O_NOCTTY);
#endif
#ifdef O_TRUNC
  SCR_FS_CONSTANT(o, O_TRUNC);
#endif
#ifdef O_APPEND
  SCR_FS_CONSTANT(o, O_APPEND);
#endif
#ifdef O_DIRECTORY
  SCR_FS_CONSTANT(o, O_DIRECTORY);
#endif
#ifdef O_NOATIME
  SCR_FS_CONSTANT(o, O_NOATIME);
#endif
#ifdef O_NOFOLLOW
  SCR_FS_CONSTANT(o, O_NOFOLLOW);
#endif
#ifdef O_SYNC
  SCR_FS_CONSTANT(o, O_SYNC);
#endif
#ifdef O_DSYNC
  SCR_FS_CONSTANT(o, O_DSYNC);
#endif
#ifdef O_SYMLINK
  SCR_FS_CONSTANT(o, O_SYMLINK);
#endif
#ifdef O_DIRECT
  SCR_FS_CONSTANT(o, O_DIRECT);
#endif
#ifdef O_NONBLOCK
  SCR_FS_CONSTANT(o, O_NONBLOCK);
#endif
#ifdef S_IRWXU
  SCR_FS_CONSTANT(o, S_IRWXU);
#endif
#ifdef S_IRUSR
  SCR_FS_CONSTANT(o, S_IRUSR);
#endif
#ifdef S_IWUSR
  SCR_FS_CONSTANT(o, S_IWUSR);
#endif
#ifdef S_IXUSR
  SCR_FS_CONSTANT(o, S_IXUSR);
#endif
#ifdef S_IRWXG
  SCR_FS_CONSTANT(o, S_IRWXG);
#endif
#ifdef S_IRGRP
  SCR_FS_CONSTANT(o, S_IRGRP);
#endif
#ifdef S_IWGRP
  SCR_FS_CONSTANT(o, S_IWGRP);
#endif
#ifdef S_IXGRP
  SCR_FS_CONSTANT(o, S_IXGRP);
#endif
#ifdef S_IRWXO
  SCR_FS_CONSTANT(o, S_IRWXO);
#endif
#ifdef S_IROTH
  SCR_FS_CONSTANT(o, S_IROTH);
#endif
#ifdef S_IWOTH
  SCR_FS_CONSTANT(o, S_IWOTH);
#endif
#ifdef S_IXOTH
  SCR_FS_CONSTANT(o, S_IXOTH);
#endif
#ifdef F_OK
  SCR_FS_CONSTANT(o, F_OK);
#endif
#ifdef R_OK
  SCR_FS_CONSTANT(o, R_OK);
#endif
#ifdef W_OK
  SCR_FS_CONSTANT(o, W_OK);
#endif
#ifdef X_OK
  SCR_FS_CONSTANT(o, X_OK);
#endif
  scr_os_constant(o, "UV_FS_COPYFILE_EXCL", 1);
  scr_os_constant(o, "COPYFILE_EXCL", 1);
  scr_os_constant(o, "UV_FS_COPYFILE_FICLONE", 2);
  scr_os_constant(o, "COPYFILE_FICLONE", 2);
  scr_os_constant(o, "UV_FS_COPYFILE_FICLONE_FORCE", 4);
  scr_os_constant(o, "COPYFILE_FICLONE_FORCE", 4);
}
#undef SCR_FS_CONSTANT

static SCR_TL ScrDyn *scr_node_constants_value;
static void scr_node_constants_clear(void) {
  ScrDyn *value = scr_node_constants_value;
  scr_node_constants_value = NULL;
  scr_dyn_release(value);
}

ScrDyn *scr_node_constants(const ScrDyn *crypto_table) {
  if (scr_node_constants_value) return scr_dyn_retain(scr_node_constants_value);
  ScrDyn *crypto = scr_dyn_call(crypto_table, NULL, 0, "constants");
  if (!crypto) return NULL;
  ScrDyn *o = scr_dyn_new_obj();
  scr_os_dlopen_constants(o);
  scr_os_errno_constants(o);
  scr_os_constant(o, "PRIORITY_LOW", SCR_OS_PRIORITY_LOW);
  scr_os_constant(o, "PRIORITY_BELOW_NORMAL", SCR_OS_PRIORITY_BELOW_NORMAL);
  scr_os_constant(o, "PRIORITY_NORMAL", SCR_OS_PRIORITY_NORMAL);
  scr_os_constant(o, "PRIORITY_ABOVE_NORMAL", SCR_OS_PRIORITY_ABOVE_NORMAL);
  scr_os_constant(o, "PRIORITY_HIGH", SCR_OS_PRIORITY_HIGH);
  scr_os_constant(o, "PRIORITY_HIGHEST", SCR_OS_PRIORITY_HIGHEST);
  scr_os_signal_constants(o);
  scr_fs_constants(o);
  if (crypto && crypto->kind == SCR_DYN_OBJ) {
    for (size_t i = 0; i < scr_dyn_obj_count(crypto); i++) {
      ScrDynProp entry = scr_dyn_obj_prop_at(crypto, i);
      if (entry.accessor || !entry.value) continue;
      scr_dyn_obj_set(o, entry.key, entry.key_len, scr_dyn_retain(entry.value));
    }
  }
  scr_dyn_release(crypto);
  scr_dyn_release(scr_dyn_freeze_data(o));
  scr_node_constants_value = o;
  scr_atexit(scr_node_constants_clear);
  return scr_dyn_retain(o);
}

/* fs.constants as a value: node_constants.cc's fs group (the set
 * node:constants merges above), in its order and under its #ifdef guards,
 * on its own cached null-prototype object with read-only members. It keeps
 * its own table instead of calling the scr_fs_constants fill: a second
 * caller would stop that static from inlining into scr_node_constants and
 * change every binary that links node:constants. The names live inside
 * the table entries, so the table is one data object section GC drops.
 * Nothing on an existing path calls this. */
typedef struct {
  char name[32];
  double value;
} ScrFsConstant;
#define SCR_FS_C(n) {#n, (double)(n)}
static const ScrFsConstant scr_fs_constant_table[] = {
    {"UV_FS_SYMLINK_DIR", 1},
    {"UV_FS_SYMLINK_JUNCTION", 2},
#ifdef O_RDONLY
    SCR_FS_C(O_RDONLY),
#endif
#ifdef O_WRONLY
    SCR_FS_C(O_WRONLY),
#endif
#ifdef O_RDWR
    SCR_FS_C(O_RDWR),
#endif
    {"UV_DIRENT_UNKNOWN", 0},
    {"UV_DIRENT_FILE", 1},
    {"UV_DIRENT_DIR", 2},
    {"UV_DIRENT_LINK", 3},
    {"UV_DIRENT_FIFO", 4},
    {"UV_DIRENT_SOCKET", 5},
    {"UV_DIRENT_CHAR", 6},
    {"UV_DIRENT_BLOCK", 7},
#ifdef S_IFMT
    SCR_FS_C(S_IFMT),
#endif
#ifdef S_IFREG
    SCR_FS_C(S_IFREG),
#endif
#ifdef S_IFDIR
    SCR_FS_C(S_IFDIR),
#endif
#ifdef S_IFCHR
    SCR_FS_C(S_IFCHR),
#endif
#ifdef S_IFBLK
    SCR_FS_C(S_IFBLK),
#endif
#ifdef S_IFIFO
    SCR_FS_C(S_IFIFO),
#endif
#ifdef S_IFLNK
    SCR_FS_C(S_IFLNK),
#endif
#ifdef S_IFSOCK
    SCR_FS_C(S_IFSOCK),
#endif
#ifdef O_CREAT
    SCR_FS_C(O_CREAT),
#endif
#ifdef O_EXCL
    SCR_FS_C(O_EXCL),
#endif
    {"UV_FS_O_FILEMAP", 0},
    {"UV_FS_O_TEMPORARY", 0},
    {"UV_FS_O_SHORT_LIVED", 0},
    {"UV_FS_O_SEQUENTIAL", 0},
    {"UV_FS_O_RANDOM", 0},
#ifdef O_NOCTTY
    SCR_FS_C(O_NOCTTY),
#endif
#ifdef O_TRUNC
    SCR_FS_C(O_TRUNC),
#endif
#ifdef O_APPEND
    SCR_FS_C(O_APPEND),
#endif
#ifdef O_DIRECTORY
    SCR_FS_C(O_DIRECTORY),
#endif
#ifdef O_NOATIME
    SCR_FS_C(O_NOATIME),
#endif
#ifdef O_NOFOLLOW
    SCR_FS_C(O_NOFOLLOW),
#endif
#ifdef O_SYNC
    SCR_FS_C(O_SYNC),
#endif
#ifdef O_DSYNC
    SCR_FS_C(O_DSYNC),
#endif
#ifdef O_SYMLINK
    SCR_FS_C(O_SYMLINK),
#endif
#ifdef O_DIRECT
    SCR_FS_C(O_DIRECT),
#endif
#ifdef O_NONBLOCK
    SCR_FS_C(O_NONBLOCK),
#endif
#ifdef S_IRWXU
    SCR_FS_C(S_IRWXU),
#endif
#ifdef S_IRUSR
    SCR_FS_C(S_IRUSR),
#endif
#ifdef S_IWUSR
    SCR_FS_C(S_IWUSR),
#endif
#ifdef S_IXUSR
    SCR_FS_C(S_IXUSR),
#endif
#ifdef S_IRWXG
    SCR_FS_C(S_IRWXG),
#endif
#ifdef S_IRGRP
    SCR_FS_C(S_IRGRP),
#endif
#ifdef S_IWGRP
    SCR_FS_C(S_IWGRP),
#endif
#ifdef S_IXGRP
    SCR_FS_C(S_IXGRP),
#endif
#ifdef S_IRWXO
    SCR_FS_C(S_IRWXO),
#endif
#ifdef S_IROTH
    SCR_FS_C(S_IROTH),
#endif
#ifdef S_IWOTH
    SCR_FS_C(S_IWOTH),
#endif
#ifdef S_IXOTH
    SCR_FS_C(S_IXOTH),
#endif
#ifdef F_OK
    SCR_FS_C(F_OK),
#endif
#ifdef R_OK
    SCR_FS_C(R_OK),
#endif
#ifdef W_OK
    SCR_FS_C(W_OK),
#endif
#ifdef X_OK
    SCR_FS_C(X_OK),
#endif
    {"UV_FS_COPYFILE_EXCL", 1},
    {"COPYFILE_EXCL", 1},
    {"UV_FS_COPYFILE_FICLONE", 2},
    {"COPYFILE_FICLONE", 2},
    {"UV_FS_COPYFILE_FICLONE_FORCE", 4},
    {"COPYFILE_FICLONE_FORCE", 4},
};
#undef SCR_FS_C

static SCR_TL ScrDyn *scr_fs_constants_value;
static void scr_fs_constants_clear(void) {
  ScrDyn *value = scr_fs_constants_value;
  scr_fs_constants_value = NULL;
  scr_dyn_release(value);
}

ScrDyn *scr_fs_constants_object(void) {
  if (scr_fs_constants_value) return scr_dyn_retain(scr_fs_constants_value);
  ScrDyn *o = scr_dyn_new_obj_null_proto();
  for (size_t i = 0; i < sizeof scr_fs_constant_table / sizeof scr_fs_constant_table[0]; i++)
    scr_os_constant(o, scr_fs_constant_table[i].name, scr_fs_constant_table[i].value);
  scr_fs_constants_value = o;
  scr_atexit(scr_fs_constants_clear);
  return scr_dyn_retain(o);
}

/* util.convertProcessSignalToExitCode(signalCode): 128 plus the number of
 * the os.constants.signals entry, and validateOneOf's
 * ERR_INVALID_ARG_VALUE, listing every name, for anything else. NaN with
 * the exception pending. */
double scr_util_signal_exit_code(const ScrDyn *code) {
  ScrDyn *signals = scr_dyn_new_obj();
  scr_os_signal_constants(signals);
  const ScrDyn *number =
      code->kind == SCR_DYN_STR ? scr_dyn_obj_get(signals, code->v.str->data, code->v.str->len) : NULL;
  double result = NAN;
  if (number && number->kind == SCR_DYN_NUM) {
    result = 128 + number->v.num;
  } else {
    ScrJsonBuf reason;
    scr_jb_init(&reason);
    scr_jb_puts(&reason, "must be one of: ");
    for (size_t i = 0; i < scr_dyn_obj_count(signals); i++) {
      if (i > 0) scr_jb_puts(&reason, ", ");
      scr_jb_putc(&reason, '\'');
      size_t key_len;
      const char *key = scr_dyn_obj_key_at(signals, i, &key_len);
      scr_jb_write(&reason, key, key_len);
      scr_jb_putc(&reason, '\'');
    }
    ScrStr *text = scr_jb_finish(&reason);
    scr_dyn_arg_value_fail("signalCode", text->data, code);
    scr_str_release(text);
  }
  scr_dyn_release(signals);
  return result;
}
