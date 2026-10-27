/* scriptc runtime — node:os (scr_lib.c, scr_os.c). Included by scr_runtime.h,
 * which says where new declarations go. */
#ifndef SCR_OS_H
#define SCR_OS_H

#include "scr_exception.h"

/* ── node:os (scr_lib.c) ─────────────────────────────────────────────
 * os.platform() lowers to scr_process_platform. homedir is $HOME else
 * getpwuid(3) (failure aborts); tmpdir is Node's $TMPDIR/$TMP/$TEMP
 * cascade else /tmp, one trailing slash trimmed. Both +1 fresh. */
ScrStr *scr_os_homedir(void);
ScrStr *scr_os_tmpdir(void);
ScrStr *scr_os_release(void); /* uname(2) release — +1 fresh */
ScrStr *scr_os_type(void);    /* uname(2) sysname — +1 fresh */
double scr_os_totalmem(void); /* total physical memory, bytes */
/* node:os host facts (scr_os.c), libuv's answers: uname machine/version,
 * the host name, "LE"/"BE", free memory in bytes, uptime in seconds and
 * the 1/5/15-minute load averages (+1 fresh results; never throw). */
ScrStr *scr_os_machine(void);
ScrStr *scr_os_version(void);
ScrStr *scr_os_hostname(void);
ScrStr *scr_os_endianness(void);
double scr_os_freemem(void);
double scr_os_uptime(void);
/* util.convertProcessSignalToExitCode: 128 plus the signal number, or NaN
 * with ERR_INVALID_ARG_VALUE pending (scr_os.c). */
double scr_util_signal_exit_code(const struct ScrDyn *code);
ScrArr *scr_os_loadavg(void);
/* os.getPriority(pid): validateInt32, then the scheduling priority;
 * failures throw Node's RangeError or SystemError (ERR_SYSTEM_ERROR). */
double scr_os_get_priority(double pid);
/* os.setPriority(pid, priority): validateInt32 for both (priority within
 * -20..19), then the scheduling priority; failures throw Node's RangeError
 * or SystemError (ERR_SYSTEM_ERROR). */
void scr_os_set_priority(double pid, double priority);
/* os.cpus(): take answers the CPU count of a fresh snapshot; model and
 * field (0 speed, 1 user, 2 nice, 3 sys, 4 idle, 5 irq) read it. */
double scr_os_cpus_take(void);
ScrStr *scr_os_cpus_model(double i);
double scr_os_cpus_field(double i, double field);
/* os.constants: the per-thread null-prototype constants object (+1). */
ScrDyn *scr_os_constants(void);
/* fs.constants: the target's null-prototype constants object (cached, +1). */
ScrDyn *scr_fs_constants_object(void);
/* The deprecated node:constants module object (scr_os.c): the os groups,
 * fs.constants and the crypto table the borrowed function answers, merged
 * and frozen (+1). */
ScrDyn *scr_node_constants(const ScrDyn *crypto_table);
double scr_os_available_parallelism(void); /* uv_available_parallelism: CPUs this process may use, >= 1 */
/* os.userInfo()'s field trio (pw_name / pw_shell / pw_dir — the passwd
 * home, not the $HOME cascade). +1 fresh; abort on lookup failure. */
ScrStr *scr_os_user_name(void);
ScrStr *scr_os_user_shell(void);
ScrStr *scr_os_user_homedir(void);

/* fs.readdirSync(path, { withFileTypes: true }): one readdir pass
 * snapshotting name + entry kind (scr_lib.c) — the emitter walks it to
 * assemble the typed Dirent record rows inline. Entry kinds use libuv's
 * UV_DIRENT encoding (1 file, 2 dir, 3 link, 4 fifo, 5 socket, 6 char,
 * 7 block, 0 unknown); a DT_UNKNOWN d_type falls back to lstat(2) —
 * Node's own getDirents rule. Byte order on POSIX (libuv's scandir sorts
 * with strcmp), the directory's order on Windows; no "."/"..". scr_fs_scandir
 * throws Node's scandir errno error and answers NULL then; count/free are
 * NULL-tolerant so the promise emitter can turn that pending error into a
 * rejection, while the name accessor returns +1. */
typedef struct ScrScandir ScrScandir;
ScrScandir *scr_fs_scandir(ScrStr *path); /* or throws (NULL) */
size_t scr_fs_scandir_count(const ScrScandir *s); /* NULL -> 0 */
ScrStr *scr_fs_scandir_name(const ScrScandir *s, size_t i); /* +1 */
double scr_fs_scandir_type(const ScrScandir *s, size_t i);
void scr_fs_scandir_free(ScrScandir *s); /* NULL-tolerant */

/* fs.Dir (opendirSync, fs.promises.opendir; scr_lib.c): an open directory
 * stream read one entry at a time in OS order, like libuv's uv_fs_readdir.
 * scr_dir_read answers true with a +1 name and its UV_DIRENT kind (the
 * scandir encoding), false at the end; a closed Dir throws ERR_DIR_CLOSED
 * from read and close. Releasing the last reference closes the stream.
 * scr_fs_opendir throws Node's opendir errno error (no path), or the
 * options.bufferSize RangeError, and answers NULL then. */
typedef struct ScrDir ScrDir;
ScrDir *scr_fs_opendir(ScrStr *path, double buffer_size); /* +1, or throws (NULL) */
ScrDir *scr_dir_retain(ScrDir *d);
void scr_dir_release(ScrDir *d);
void *scr_dir_retain_v(void *p);
void scr_dir_release_v(void *p);
ScrStr *scr_dir_path(ScrDir *d); /* +1 */
bool scr_dir_read(ScrDir *d, ScrStr **name, double *kind);
void scr_dir_close(ScrDir *d);

/* os.networkInterfaces(): a getifaddrs(3) snapshot (scr_lib.c) the emitter
 * walks to build the typed Dict<NetworkInterfaceInfo[]> record inline. Row
 * selection and fields follow libuv/Node (IFF_UP && IFF_RUNNING,
 * AF_INET/AF_INET6; internal = IFF_LOOPBACK; MAC from the link-level
 * sibling entry, zeros when absent; cidr = address/<netmask prefix>, NULL
 * for a split netmask — Node's null). String accessors return +1; a
 * getifaddrs failure yields an empty snapshot. */
typedef struct ScrIfaddrs ScrIfaddrs;
ScrIfaddrs *scr_os_ifaddrs(void);
size_t scr_os_ifaddrs_count(const ScrIfaddrs *s);
ScrStr *scr_os_ifaddrs_name(const ScrIfaddrs *s, size_t i);
ScrStr *scr_os_ifaddrs_address(const ScrIfaddrs *s, size_t i);
ScrStr *scr_os_ifaddrs_netmask(const ScrIfaddrs *s, size_t i);
ScrStr *scr_os_ifaddrs_family(const ScrIfaddrs *s, size_t i); /* "IPv4"/"IPv6" */
ScrStr *scr_os_ifaddrs_mac(const ScrIfaddrs *s, size_t i);
bool scr_os_ifaddrs_internal(const ScrIfaddrs *s, size_t i);
bool scr_os_ifaddrs_ipv6(const ScrIfaddrs *s, size_t i);
ScrStr *scr_os_ifaddrs_cidr(const ScrIfaddrs *s, size_t i); /* +1 or NULL */
double scr_os_ifaddrs_scopeid(const ScrIfaddrs *s, size_t i);
void scr_os_ifaddrs_free(ScrIfaddrs *s);

#endif /* SCR_OS_H */
