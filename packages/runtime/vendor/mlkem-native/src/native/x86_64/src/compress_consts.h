/*
 * Copyright (c) The mlkem-native project authors
 * SPDX-License-Identifier: Apache-2.0 OR ISC OR MIT
 */

/*
 * WARNING: This file is auto-generated from scripts/autogen
 *          in the mlkem-native repository.
 *          Do not modify it directly.
 */

#ifndef MLK_NATIVE_X86_64_SRC_COMPRESS_CONSTS_H
#define MLK_NATIVE_X86_64_SRC_COMPRESS_CONSTS_H

#include "../../../common.h"

#ifndef __ASSEMBLER__

#define mlk_compress_d4_data MLK_NAMESPACE(compress_d4_data)
MLK_INTERNAL_DATA_DECLARATION const uint8_t mlk_compress_d4_data[32];

#if !defined(MLK_CONFIG_NO_DECAPS_API)
#define mlk_decompress_d4_data MLK_NAMESPACE(decompress_d4_data)
MLK_INTERNAL_DATA_DECLARATION const uint8_t mlk_decompress_d4_data[32];
#endif

#define mlk_compress_d10_data MLK_NAMESPACE(compress_d10_data)
MLK_INTERNAL_DATA_DECLARATION const uint8_t mlk_compress_d10_data[32];

#if !defined(MLK_CONFIG_NO_DECAPS_API)
#define mlk_decompress_d10_data MLK_NAMESPACE(decompress_d10_data)
MLK_INTERNAL_DATA_DECLARATION const uint8_t mlk_decompress_d10_data[32];
#endif

#define mlk_compress_d5_data MLK_NAMESPACE(compress_d5_data)
MLK_INTERNAL_DATA_DECLARATION const uint8_t mlk_compress_d5_data[32];

#if !defined(MLK_CONFIG_NO_DECAPS_API)
#define mlk_decompress_d5_data MLK_NAMESPACE(decompress_d5_data)
MLK_INTERNAL_DATA_DECLARATION const uint8_t mlk_decompress_d5_data[96];
#endif

#define mlk_compress_d11_data MLK_NAMESPACE(compress_d11_data)
MLK_INTERNAL_DATA_DECLARATION const uint8_t mlk_compress_d11_data[64];

#if !defined(MLK_CONFIG_NO_DECAPS_API)
#define mlk_decompress_d11_data MLK_NAMESPACE(decompress_d11_data)
MLK_INTERNAL_DATA_DECLARATION const uint8_t mlk_decompress_d11_data[128];
#endif

#endif /* !__ASSEMBLER__ */

#endif /* !MLK_NATIVE_X86_64_SRC_COMPRESS_CONSTS_H */
