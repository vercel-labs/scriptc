/* Copyright Joyent, Inc. and other Node contributors. All rights reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to
 * deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 */

#ifndef SCR_NODE_UV_ERRNO_H_
#define SCR_NODE_UV_ERRNO_H_

/* Node v24.22.1, commit d01285110044365f0ad4fec24482a585646640e2.
 * libuv errno values and messages are part of node:util's observable API.
 * Kept independent of libuv so native binaries need no additional library. */
#include <errno.h>
#if EDOM > 0
# define SCR_NODE_UV__ERR(x) (-(x))
#else
# define SCR_NODE_UV__ERR(x) (x)
#endif

#define SCR_NODE_UV__EOF     (-4095)
#define SCR_NODE_UV__UNKNOWN (-4094)

#define SCR_NODE_UV__EAI_ADDRFAMILY  (-3000)
#define SCR_NODE_UV__EAI_AGAIN       (-3001)
#define SCR_NODE_UV__EAI_BADFLAGS    (-3002)
#define SCR_NODE_UV__EAI_CANCELED    (-3003)
#define SCR_NODE_UV__EAI_FAIL        (-3004)
#define SCR_NODE_UV__EAI_FAMILY      (-3005)
#define SCR_NODE_UV__EAI_MEMORY      (-3006)
#define SCR_NODE_UV__EAI_NODATA      (-3007)
#define SCR_NODE_UV__EAI_NONAME      (-3008)
#define SCR_NODE_UV__EAI_OVERFLOW    (-3009)
#define SCR_NODE_UV__EAI_SERVICE     (-3010)
#define SCR_NODE_UV__EAI_SOCKTYPE    (-3011)
#define SCR_NODE_UV__EAI_BADHINTS    (-3013)
#define SCR_NODE_UV__EAI_PROTOCOL    (-3014)

/* Only map to the system errno on non-Windows platforms. It's apparently
 * a fairly common practice for Windows programmers to redefine errno codes.
 */
#if defined(E2BIG) && !defined(_WIN32)
# define SCR_NODE_UV__E2BIG SCR_NODE_UV__ERR(E2BIG)
#else
# define SCR_NODE_UV__E2BIG (-4093)
#endif

#if defined(EACCES) && !defined(_WIN32)
# define SCR_NODE_UV__EACCES SCR_NODE_UV__ERR(EACCES)
#else
# define SCR_NODE_UV__EACCES (-4092)
#endif

#if defined(EADDRINUSE) && !defined(_WIN32)
# define SCR_NODE_UV__EADDRINUSE SCR_NODE_UV__ERR(EADDRINUSE)
#else
# define SCR_NODE_UV__EADDRINUSE (-4091)
#endif

#if defined(EADDRNOTAVAIL) && !defined(_WIN32)
# define SCR_NODE_UV__EADDRNOTAVAIL SCR_NODE_UV__ERR(EADDRNOTAVAIL)
#else
# define SCR_NODE_UV__EADDRNOTAVAIL (-4090)
#endif

#if defined(EAFNOSUPPORT) && !defined(_WIN32)
# define SCR_NODE_UV__EAFNOSUPPORT SCR_NODE_UV__ERR(EAFNOSUPPORT)
#else
# define SCR_NODE_UV__EAFNOSUPPORT (-4089)
#endif

#if defined(EAGAIN) && !defined(_WIN32)
# define SCR_NODE_UV__EAGAIN SCR_NODE_UV__ERR(EAGAIN)
#else
# define SCR_NODE_UV__EAGAIN (-4088)
#endif

#if defined(EALREADY) && !defined(_WIN32)
# define SCR_NODE_UV__EALREADY SCR_NODE_UV__ERR(EALREADY)
#else
# define SCR_NODE_UV__EALREADY (-4084)
#endif

#if defined(EBADF) && !defined(_WIN32)
# define SCR_NODE_UV__EBADF SCR_NODE_UV__ERR(EBADF)
#else
# define SCR_NODE_UV__EBADF (-4083)
#endif

#if defined(EBUSY) && !defined(_WIN32)
# define SCR_NODE_UV__EBUSY SCR_NODE_UV__ERR(EBUSY)
#else
# define SCR_NODE_UV__EBUSY (-4082)
#endif

#if defined(ECANCELED) && !defined(_WIN32)
# define SCR_NODE_UV__ECANCELED SCR_NODE_UV__ERR(ECANCELED)
#else
# define SCR_NODE_UV__ECANCELED (-4081)
#endif

#if defined(ECHARSET) && !defined(_WIN32)
# define SCR_NODE_UV__ECHARSET SCR_NODE_UV__ERR(ECHARSET)
#else
# define SCR_NODE_UV__ECHARSET (-4080)
#endif

#if defined(ECONNABORTED) && !defined(_WIN32)
# define SCR_NODE_UV__ECONNABORTED SCR_NODE_UV__ERR(ECONNABORTED)
#else
# define SCR_NODE_UV__ECONNABORTED (-4079)
#endif

#if defined(ECONNREFUSED) && !defined(_WIN32)
# define SCR_NODE_UV__ECONNREFUSED SCR_NODE_UV__ERR(ECONNREFUSED)
#else
# define SCR_NODE_UV__ECONNREFUSED (-4078)
#endif

#if defined(ECONNRESET) && !defined(_WIN32)
# define SCR_NODE_UV__ECONNRESET SCR_NODE_UV__ERR(ECONNRESET)
#else
# define SCR_NODE_UV__ECONNRESET (-4077)
#endif

#if defined(EDESTADDRREQ) && !defined(_WIN32)
# define SCR_NODE_UV__EDESTADDRREQ SCR_NODE_UV__ERR(EDESTADDRREQ)
#else
# define SCR_NODE_UV__EDESTADDRREQ (-4076)
#endif

#if defined(EEXIST) && !defined(_WIN32)
# define SCR_NODE_UV__EEXIST SCR_NODE_UV__ERR(EEXIST)
#else
# define SCR_NODE_UV__EEXIST (-4075)
#endif

#if defined(EFAULT) && !defined(_WIN32)
# define SCR_NODE_UV__EFAULT SCR_NODE_UV__ERR(EFAULT)
#else
# define SCR_NODE_UV__EFAULT (-4074)
#endif

#if defined(EHOSTUNREACH) && !defined(_WIN32)
# define SCR_NODE_UV__EHOSTUNREACH SCR_NODE_UV__ERR(EHOSTUNREACH)
#else
# define SCR_NODE_UV__EHOSTUNREACH (-4073)
#endif

#if defined(EINTR) && !defined(_WIN32)
# define SCR_NODE_UV__EINTR SCR_NODE_UV__ERR(EINTR)
#else
# define SCR_NODE_UV__EINTR (-4072)
#endif

#if defined(EINVAL) && !defined(_WIN32)
# define SCR_NODE_UV__EINVAL SCR_NODE_UV__ERR(EINVAL)
#else
# define SCR_NODE_UV__EINVAL (-4071)
#endif

#if defined(EIO) && !defined(_WIN32)
# define SCR_NODE_UV__EIO SCR_NODE_UV__ERR(EIO)
#else
# define SCR_NODE_UV__EIO (-4070)
#endif

#if defined(EISCONN) && !defined(_WIN32)
# define SCR_NODE_UV__EISCONN SCR_NODE_UV__ERR(EISCONN)
#else
# define SCR_NODE_UV__EISCONN (-4069)
#endif

#if defined(EISDIR) && !defined(_WIN32)
# define SCR_NODE_UV__EISDIR SCR_NODE_UV__ERR(EISDIR)
#else
# define SCR_NODE_UV__EISDIR (-4068)
#endif

#if defined(ELOOP) && !defined(_WIN32)
# define SCR_NODE_UV__ELOOP SCR_NODE_UV__ERR(ELOOP)
#else
# define SCR_NODE_UV__ELOOP (-4067)
#endif

#if defined(EMFILE) && !defined(_WIN32)
# define SCR_NODE_UV__EMFILE SCR_NODE_UV__ERR(EMFILE)
#else
# define SCR_NODE_UV__EMFILE (-4066)
#endif

#if defined(EMSGSIZE) && !defined(_WIN32)
# define SCR_NODE_UV__EMSGSIZE SCR_NODE_UV__ERR(EMSGSIZE)
#else
# define SCR_NODE_UV__EMSGSIZE (-4065)
#endif

#if defined(ENAMETOOLONG) && !defined(_WIN32)
# define SCR_NODE_UV__ENAMETOOLONG SCR_NODE_UV__ERR(ENAMETOOLONG)
#else
# define SCR_NODE_UV__ENAMETOOLONG (-4064)
#endif

#if defined(ENETDOWN) && !defined(_WIN32)
# define SCR_NODE_UV__ENETDOWN SCR_NODE_UV__ERR(ENETDOWN)
#else
# define SCR_NODE_UV__ENETDOWN (-4063)
#endif

#if defined(ENETUNREACH) && !defined(_WIN32)
# define SCR_NODE_UV__ENETUNREACH SCR_NODE_UV__ERR(ENETUNREACH)
#else
# define SCR_NODE_UV__ENETUNREACH (-4062)
#endif

#if defined(ENFILE) && !defined(_WIN32)
# define SCR_NODE_UV__ENFILE SCR_NODE_UV__ERR(ENFILE)
#else
# define SCR_NODE_UV__ENFILE (-4061)
#endif

#if defined(ENOBUFS) && !defined(_WIN32)
# define SCR_NODE_UV__ENOBUFS SCR_NODE_UV__ERR(ENOBUFS)
#else
# define SCR_NODE_UV__ENOBUFS (-4060)
#endif

#if defined(ENODEV) && !defined(_WIN32)
# define SCR_NODE_UV__ENODEV SCR_NODE_UV__ERR(ENODEV)
#else
# define SCR_NODE_UV__ENODEV (-4059)
#endif

#if defined(ENOENT) && !defined(_WIN32)
# define SCR_NODE_UV__ENOENT SCR_NODE_UV__ERR(ENOENT)
#else
# define SCR_NODE_UV__ENOENT (-4058)
#endif

#if defined(ENOMEM) && !defined(_WIN32)
# define SCR_NODE_UV__ENOMEM SCR_NODE_UV__ERR(ENOMEM)
#else
# define SCR_NODE_UV__ENOMEM (-4057)
#endif

#if defined(ENONET) && !defined(_WIN32)
# define SCR_NODE_UV__ENONET SCR_NODE_UV__ERR(ENONET)
#else
# define SCR_NODE_UV__ENONET (-4056)
#endif

#if defined(ENOSPC) && !defined(_WIN32)
# define SCR_NODE_UV__ENOSPC SCR_NODE_UV__ERR(ENOSPC)
#else
# define SCR_NODE_UV__ENOSPC (-4055)
#endif

#if defined(ENOSYS) && !defined(_WIN32)
# define SCR_NODE_UV__ENOSYS SCR_NODE_UV__ERR(ENOSYS)
#else
# define SCR_NODE_UV__ENOSYS (-4054)
#endif

#if defined(ENOTCONN) && !defined(_WIN32)
# define SCR_NODE_UV__ENOTCONN SCR_NODE_UV__ERR(ENOTCONN)
#else
# define SCR_NODE_UV__ENOTCONN (-4053)
#endif

#if defined(ENOTDIR) && !defined(_WIN32)
# define SCR_NODE_UV__ENOTDIR SCR_NODE_UV__ERR(ENOTDIR)
#else
# define SCR_NODE_UV__ENOTDIR (-4052)
#endif

#if defined(ENOTEMPTY) && !defined(_WIN32)
# define SCR_NODE_UV__ENOTEMPTY SCR_NODE_UV__ERR(ENOTEMPTY)
#else
# define SCR_NODE_UV__ENOTEMPTY (-4051)
#endif

#if defined(ENOTSOCK) && !defined(_WIN32)
# define SCR_NODE_UV__ENOTSOCK SCR_NODE_UV__ERR(ENOTSOCK)
#else
# define SCR_NODE_UV__ENOTSOCK (-4050)
#endif

#if defined(ENOTSUP) && !defined(_WIN32)
# define SCR_NODE_UV__ENOTSUP SCR_NODE_UV__ERR(ENOTSUP)
#else
# define SCR_NODE_UV__ENOTSUP (-4049)
#endif

#if defined(EPERM) && !defined(_WIN32)
# define SCR_NODE_UV__EPERM SCR_NODE_UV__ERR(EPERM)
#else
# define SCR_NODE_UV__EPERM (-4048)
#endif

#if defined(EPIPE) && !defined(_WIN32)
# define SCR_NODE_UV__EPIPE SCR_NODE_UV__ERR(EPIPE)
#else
# define SCR_NODE_UV__EPIPE (-4047)
#endif

#if defined(EPROTO) && !defined(_WIN32)
# define SCR_NODE_UV__EPROTO SCR_NODE_UV__ERR(EPROTO)
#else
# define SCR_NODE_UV__EPROTO (-4046)
#endif

#if defined(EPROTONOSUPPORT) && !defined(_WIN32)
# define SCR_NODE_UV__EPROTONOSUPPORT SCR_NODE_UV__ERR(EPROTONOSUPPORT)
#else
# define SCR_NODE_UV__EPROTONOSUPPORT (-4045)
#endif

#if defined(EPROTOTYPE) && !defined(_WIN32)
# define SCR_NODE_UV__EPROTOTYPE SCR_NODE_UV__ERR(EPROTOTYPE)
#else
# define SCR_NODE_UV__EPROTOTYPE (-4044)
#endif

#if defined(EROFS) && !defined(_WIN32)
# define SCR_NODE_UV__EROFS SCR_NODE_UV__ERR(EROFS)
#else
# define SCR_NODE_UV__EROFS (-4043)
#endif

#if defined(ESHUTDOWN) && !defined(_WIN32)
# define SCR_NODE_UV__ESHUTDOWN SCR_NODE_UV__ERR(ESHUTDOWN)
#else
# define SCR_NODE_UV__ESHUTDOWN (-4042)
#endif

#if defined(ESPIPE) && !defined(_WIN32)
# define SCR_NODE_UV__ESPIPE SCR_NODE_UV__ERR(ESPIPE)
#else
# define SCR_NODE_UV__ESPIPE (-4041)
#endif

#if defined(ESRCH) && !defined(_WIN32)
# define SCR_NODE_UV__ESRCH SCR_NODE_UV__ERR(ESRCH)
#else
# define SCR_NODE_UV__ESRCH (-4040)
#endif

#if defined(ETIMEDOUT) && !defined(_WIN32)
# define SCR_NODE_UV__ETIMEDOUT SCR_NODE_UV__ERR(ETIMEDOUT)
#else
# define SCR_NODE_UV__ETIMEDOUT (-4039)
#endif

#if defined(ETXTBSY) && !defined(_WIN32)
# define SCR_NODE_UV__ETXTBSY SCR_NODE_UV__ERR(ETXTBSY)
#else
# define SCR_NODE_UV__ETXTBSY (-4038)
#endif

#if defined(EXDEV) && !defined(_WIN32)
# define SCR_NODE_UV__EXDEV SCR_NODE_UV__ERR(EXDEV)
#else
# define SCR_NODE_UV__EXDEV (-4037)
#endif

#if defined(EFBIG) && !defined(_WIN32)
# define SCR_NODE_UV__EFBIG SCR_NODE_UV__ERR(EFBIG)
#else
# define SCR_NODE_UV__EFBIG (-4036)
#endif

#if defined(ENOPROTOOPT) && !defined(_WIN32)
# define SCR_NODE_UV__ENOPROTOOPT SCR_NODE_UV__ERR(ENOPROTOOPT)
#else
# define SCR_NODE_UV__ENOPROTOOPT (-4035)
#endif

#if defined(ERANGE) && !defined(_WIN32)
# define SCR_NODE_UV__ERANGE SCR_NODE_UV__ERR(ERANGE)
#else
# define SCR_NODE_UV__ERANGE (-4034)
#endif

#if defined(ENXIO) && !defined(_WIN32)
# define SCR_NODE_UV__ENXIO SCR_NODE_UV__ERR(ENXIO)
#else
# define SCR_NODE_UV__ENXIO (-4033)
#endif

#if defined(EMLINK) && !defined(_WIN32)
# define SCR_NODE_UV__EMLINK SCR_NODE_UV__ERR(EMLINK)
#else
# define SCR_NODE_UV__EMLINK (-4032)
#endif

/* EHOSTDOWN is not visible on BSD-like systems when _POSIX_C_SOURCE is
 * defined. Fortunately, its value is always 64 so it's possible albeit
 * icky to hard-code it.
 */
#if defined(EHOSTDOWN) && !defined(_WIN32)
# define SCR_NODE_UV__EHOSTDOWN SCR_NODE_UV__ERR(EHOSTDOWN)
#elif defined(__APPLE__) || \
      defined(__DragonFly__) || \
      defined(__FreeBSD__) || \
      defined(__NetBSD__) || \
      defined(__OpenBSD__)
# define SCR_NODE_UV__EHOSTDOWN (-64)
#else
# define SCR_NODE_UV__EHOSTDOWN (-4031)
#endif

#if defined(EREMOTEIO) && !defined(_WIN32)
# define SCR_NODE_UV__EREMOTEIO SCR_NODE_UV__ERR(EREMOTEIO)
#else
# define SCR_NODE_UV__EREMOTEIO (-4030)
#endif

#if defined(ENOTTY) && !defined(_WIN32)
# define SCR_NODE_UV__ENOTTY SCR_NODE_UV__ERR(ENOTTY)
#else
# define SCR_NODE_UV__ENOTTY (-4029)
#endif

#if defined(EFTYPE) && !defined(_WIN32)
# define SCR_NODE_UV__EFTYPE SCR_NODE_UV__ERR(EFTYPE)
#else
# define SCR_NODE_UV__EFTYPE (-4028)
#endif

#if defined(EILSEQ) && !defined(_WIN32)
# define SCR_NODE_UV__EILSEQ SCR_NODE_UV__ERR(EILSEQ)
#else
# define SCR_NODE_UV__EILSEQ (-4027)
#endif

#if defined(EOVERFLOW) && !defined(_WIN32)
# define SCR_NODE_UV__EOVERFLOW SCR_NODE_UV__ERR(EOVERFLOW)
#else
# define SCR_NODE_UV__EOVERFLOW (-4026)
#endif

#if defined(ESOCKTNOSUPPORT) && !defined(_WIN32)
# define SCR_NODE_UV__ESOCKTNOSUPPORT SCR_NODE_UV__ERR(ESOCKTNOSUPPORT)
#else
# define SCR_NODE_UV__ESOCKTNOSUPPORT (-4025)
#endif

/* FreeBSD defines ENODATA in /usr/include/c++/v1/errno.h which is only visible
 * if C++ is being used. Define it directly to avoid problems when integrating
 * libuv in a C++ project.
 */
#if defined(ENODATA) && !defined(_WIN32)
# define SCR_NODE_UV__ENODATA SCR_NODE_UV__ERR(ENODATA)
#elif defined(__FreeBSD__)
# define SCR_NODE_UV__ENODATA (-9919)
#else
# define SCR_NODE_UV__ENODATA (-4024)
#endif

#if defined(EUNATCH) && !defined(_WIN32)
# define SCR_NODE_UV__EUNATCH SCR_NODE_UV__ERR(EUNATCH)
#else
# define SCR_NODE_UV__EUNATCH (-4023)
#endif

#if defined(ENOEXEC) && !defined(_WIN32)
# define SCR_NODE_UV__ENOEXEC SCR_NODE_UV__ERR(ENOEXEC)
#else
# define SCR_NODE_UV__ENOEXEC (-4022)
#endif

#define SCR_NODE_UV_ERRNO_MAP(XX)                                                      \
  XX(E2BIG, "argument list too long")                                         \
  XX(EACCES, "permission denied")                                             \
  XX(EADDRINUSE, "address already in use")                                    \
  XX(EADDRNOTAVAIL, "address not available")                                  \
  XX(EAFNOSUPPORT, "address family not supported")                            \
  XX(EAGAIN, "resource temporarily unavailable")                              \
  XX(EAI_ADDRFAMILY, "address family not supported")                          \
  XX(EAI_AGAIN, "temporary failure")                                          \
  XX(EAI_BADFLAGS, "bad ai_flags value")                                      \
  XX(EAI_BADHINTS, "invalid value for hints")                                 \
  XX(EAI_CANCELED, "request canceled")                                        \
  XX(EAI_FAIL, "permanent failure")                                           \
  XX(EAI_FAMILY, "ai_family not supported")                                   \
  XX(EAI_MEMORY, "out of memory")                                             \
  XX(EAI_NODATA, "no address")                                                \
  XX(EAI_NONAME, "unknown node or service")                                   \
  XX(EAI_OVERFLOW, "argument buffer overflow")                                \
  XX(EAI_PROTOCOL, "resolved protocol is unknown")                            \
  XX(EAI_SERVICE, "service not available for socket type")                    \
  XX(EAI_SOCKTYPE, "socket type not supported")                               \
  XX(EALREADY, "connection already in progress")                              \
  XX(EBADF, "bad file descriptor")                                            \
  XX(EBUSY, "resource busy or locked")                                        \
  XX(ECANCELED, "operation canceled")                                         \
  XX(ECHARSET, "invalid Unicode character")                                   \
  XX(ECONNABORTED, "software caused connection abort")                        \
  XX(ECONNREFUSED, "connection refused")                                      \
  XX(ECONNRESET, "connection reset by peer")                                  \
  XX(EDESTADDRREQ, "destination address required")                            \
  XX(EEXIST, "file already exists")                                           \
  XX(EFAULT, "bad address in system call argument")                           \
  XX(EFBIG, "file too large")                                                 \
  XX(EHOSTUNREACH, "host is unreachable")                                     \
  XX(EINTR, "interrupted system call")                                        \
  XX(EINVAL, "invalid argument")                                              \
  XX(EIO, "i/o error")                                                        \
  XX(EISCONN, "socket is already connected")                                  \
  XX(EISDIR, "illegal operation on a directory")                              \
  XX(ELOOP, "too many symbolic links encountered")                            \
  XX(EMFILE, "too many open files")                                           \
  XX(EMSGSIZE, "message too long")                                            \
  XX(ENAMETOOLONG, "name too long")                                           \
  XX(ENETDOWN, "network is down")                                             \
  XX(ENETUNREACH, "network is unreachable")                                   \
  XX(ENFILE, "file table overflow")                                           \
  XX(ENOBUFS, "no buffer space available")                                    \
  XX(ENODEV, "no such device")                                                \
  XX(ENOENT, "no such file or directory")                                     \
  XX(ENOMEM, "not enough memory")                                             \
  XX(ENONET, "machine is not on the network")                                 \
  XX(ENOPROTOOPT, "protocol not available")                                   \
  XX(ENOSPC, "no space left on device")                                       \
  XX(ENOSYS, "function not implemented")                                      \
  XX(ENOTCONN, "socket is not connected")                                     \
  XX(ENOTDIR, "not a directory")                                              \
  XX(ENOTEMPTY, "directory not empty")                                        \
  XX(ENOTSOCK, "socket operation on non-socket")                              \
  XX(ENOTSUP, "operation not supported on socket")                            \
  XX(EOVERFLOW, "value too large for defined data type")                      \
  XX(EPERM, "operation not permitted")                                        \
  XX(EPIPE, "broken pipe")                                                    \
  XX(EPROTO, "protocol error")                                                \
  XX(EPROTONOSUPPORT, "protocol not supported")                               \
  XX(EPROTOTYPE, "protocol wrong type for socket")                            \
  XX(ERANGE, "result too large")                                              \
  XX(EROFS, "read-only file system")                                          \
  XX(ESHUTDOWN, "cannot send after transport endpoint shutdown")              \
  XX(ESPIPE, "invalid seek")                                                  \
  XX(ESRCH, "no such process")                                                \
  XX(ETIMEDOUT, "connection timed out")                                       \
  XX(ETXTBSY, "text file is busy")                                            \
  XX(EXDEV, "cross-device link not permitted")                                \
  XX(UNKNOWN, "unknown error")                                                \
  XX(EOF, "end of file")                                                      \
  XX(ENXIO, "no such device or address")                                      \
  XX(EMLINK, "too many links")                                                \
  XX(EHOSTDOWN, "host is down")                                               \
  XX(EREMOTEIO, "remote I/O error")                                           \
  XX(ENOTTY, "inappropriate ioctl for device")                                \
  XX(EFTYPE, "inappropriate file type or format")                             \
  XX(EILSEQ, "illegal byte sequence")                                         \
  XX(ESOCKTNOSUPPORT, "socket type not supported")                            \
  XX(ENODATA, "no data available")                                            \
  XX(EUNATCH, "protocol driver not attached")                                 \
  XX(ENOEXEC, "exec format error")                                            \

#endif /* SCR_NODE_UV_ERRNO_H_ */
