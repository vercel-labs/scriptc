/*
 * Copyright (c) The mlkem-native project authors
 * SPDX-License-Identifier: Apache-2.0 OR ISC OR MIT
 */
#ifndef MLK_NATIVE_META_H
#define MLK_NATIVE_META_H

/*
 * Default arithmetic backend
 */
#include "../sys.h"

#ifdef MLK_SYS_AARCH64_NEON
#include "aarch64/meta.h"
#endif

/* The x86_64 backend requires toolchain support for the SysV ABI */
#if defined(MLK_SYS_X86_64_AVX2) && defined(MLK_SYSV_ABI_SUPPORTED)
#include "x86_64/meta.h"
#endif

#if defined(MLK_SYS_RISCV64_RVV)
#include "riscv64/meta.h"
#endif

#ifdef MLK_SYS_PPC64LE
#include "ppc64le/meta.h"
#endif

#endif /* !MLK_NATIVE_META_H */
