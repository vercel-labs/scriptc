/*
 * Copyright (c) The mlkem-native project authors
 * SPDX-License-Identifier: Apache-2.0 OR ISC OR MIT
 */

/*
 * WARNING: This file is auto-generated from scripts/autogen
 *          in the mlkem-native repository.
 *          Do not modify it directly.
 */

#ifndef MLK_NATIVE_PPC64LE_SRC_CONSTS_H
#define MLK_NATIVE_PPC64LE_SRC_CONSTS_H
#include "../../../common.h"

/* Byte offsets into the constant table */
#define MLK_PPC_NQ_OFFSET 0
#define MLK_PPC_Q_OFFSET 16
#define MLK_PPC_C20159_OFFSET 32
#define MLK_PPC_N_INV_OFFSET 48
#define MLK_PPC_N_INV_TW_OFFSET 64
#define MLK_PPC_TOMONT_OFFSET 80
#define MLK_PPC_TOMONT_TW_OFFSET 96
#define MLK_PPC_ZETA_NTT_OFFSET 112
#define MLK_PPC_ZETA_INTT_OFFSET 1120
#define MLK_PPC_ZETA_NTT_TW_OFFSET 2128
#define MLK_PPC_ZETA_INTT_TW_OFFSET 3136

#ifndef __ASSEMBLER__
#define mlk_ppc_qdata MLK_NAMESPACE(ppc_qdata)
MLK_INTERNAL_DATA_DECLARATION const int16_t mlk_ppc_qdata[2072];
#endif

#endif /* !MLK_NATIVE_PPC64LE_SRC_CONSTS_H */
