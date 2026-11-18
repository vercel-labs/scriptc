/*
 * Copyright (c) The mlkem-native project authors
 * SPDX-License-Identifier: Apache-2.0 OR ISC OR MIT
 */

#ifndef MLK_CBMC_H
#define MLK_CBMC_H
/***************************************************
 * Basic replacements for __CPROVER_XXX contracts
 ***************************************************/
/*
 * The `__contract__` / `__loop__` annotation macros use a
 * leading-double-underscore spelling in line with other CBMC macros.
 * clang-tidy flags these as reserved identifiers; we suppress the diagnostic
 * at each definition site (NOLINT) rather than disabling the check globally,
 * so it stays active for the rest of the tree.
 */
#ifndef CBMC

/* clang-format off */
#define __contract__(x) /* NOLINT(bugprone-reserved-identifier,cert-dcl37-c,cert-dcl51-cpp) */
#define __loop__(x) /* NOLINT(bugprone-reserved-identifier,cert-dcl37-c,cert-dcl51-cpp) */
/* clang-format on */

#else /* !CBMC */


/* clang-format off */
#define __contract__(x) x /* NOLINT(bugprone-reserved-identifier,cert-dcl37-c,cert-dcl51-cpp) */
#define __loop__(x) x /* NOLINT(bugprone-reserved-identifier,cert-dcl37-c,cert-dcl51-cpp) */
/* clang-format on */

/* https://diffblue.github.io/cbmc/contracts-assigns.html */
#define assigns(...) __CPROVER_assigns(__VA_ARGS__)

/* https://diffblue.github.io/cbmc/contracts-requires-ensures.html */
#define requires(...) __CPROVER_requires(__VA_ARGS__)
#define ensures(...) __CPROVER_ensures(__VA_ARGS__)
/* https://diffblue.github.io/cbmc/contracts-loops.html */
#define invariant(...) __CPROVER_loop_invariant(__VA_ARGS__)
#define decreases(...) __CPROVER_decreases(__VA_ARGS__)
/* cassert to avoid confusion with in-built assert */
#define cassert(x) __CPROVER_assert(x, "cbmc assertion failed")
#define assume(...) __CPROVER_assume(__VA_ARGS__)

/***************************************************
 * Macros for "expression" forms that may appear
 * _inside_ top-level contracts.
 ***************************************************/

/*
 * function return value - useful inside ensures
 * https://diffblue.github.io/cbmc/contracts-functions.html
 */
#define return_value (__CPROVER_return_value)

/*
 * assigns l-value targets
 * https://diffblue.github.io/cbmc/contracts-assigns.html
 */
#define object_whole(...) __CPROVER_object_whole(__VA_ARGS__)
#define memory_slice(...) __CPROVER_object_upto(__VA_ARGS__)

/*
 * Pointer-related predicates
 * https://diffblue.github.io/cbmc/contracts-memory-predicates.html
 */
#define memory_no_alias(...) __CPROVER_is_fresh(__VA_ARGS__)
#define readable(...) __CPROVER_r_ok(__VA_ARGS__)
#define writeable(...) __CPROVER_w_ok(__VA_ARGS__)

/* Maximum supported buffer size
 *
 * Larger buffers may be supported, but due to internal modeling constraints
 * in CBMC, the proofs of memory- and type-safety won't be able to run.
 *
 * If you find yourself in need for a buffer size larger than this,
 * please contact the maintainers, so we can prioritize work to relax
 * this somewhat artificial bound.
 */
#define MLK_MAX_BUFFER_SIZE (SIZE_MAX >> 12)

/*
 * History variables
 * https://diffblue.github.io/cbmc/contracts-history-variables.html
 */
#define old(...) __CPROVER_old(__VA_ARGS__)
#define loop_entry(...) __CPROVER_loop_entry(__VA_ARGS__)

/*
 * Quantifiers
 * Note that the range on qvar is _exclusive_ between qvar_lb .. qvar_ub
 * https://diffblue.github.io/cbmc/contracts-quantifiers.html
 *
 * The quantified variable is declared as uint32_t, so these macros
 * quantify only over indices in [0, UINT32_MAX). Bounds larger than
 * UINT32_MAX (4 GiB) are NOT supported: the explicit (uint32_t) casts
 * on the bounds will trigger CBMC's conversion check if a wider bound
 * (e.g. a size_t > UINT32_MAX) is passed.
 *
 * Quantifying over size_t (64-bit) was found to blow up SMT proof
 * times, so we deliberately keep the index width at 32 bits. Callers
 * dealing with size_t-typed buffers must add an explicit
 *   requires(len <= UINT32_MAX)
 * precondition.
 */

/*
 * Prevent clang-format from corrupting CBMC's special ==> operator
 */
/* clang-format off */
#define forall(qvar, qvar_lb, qvar_ub, predicate)                              \
  __CPROVER_forall                                                             \
  {                                                                            \
    uint32_t qvar;                                                             \
    ((uint32_t) (qvar_lb) <= (qvar) && (qvar) < (uint32_t) (qvar_ub)) ==> (predicate) \
  }

#define exists(qvar, qvar_lb, qvar_ub, predicate)                              \
  __CPROVER_exists                                                             \
  {                                                                            \
    uint32_t qvar;                                                             \
    ((uint32_t) (qvar_lb) <= (qvar) && (qvar) < (uint32_t) (qvar_ub)) && (predicate) \
  }
/* clang-format on */

/***************************************************
 * Convenience macros for common contract patterns
 ***************************************************/

/*
 * Boolean-value predidate that asserts that "all values of array_var are in
 * range value_lb (inclusive) .. value_ub (exclusive)"
 * Example:
 *  array_bound(a->coeffs, 0, MLKEM_N, 0, MLKEM_Q)
 * expands to
 *  __CPROVER_forall { int k; (0 <= k && k <= MLKEM_N-1) ==> (
 *  0 <= a->coeffs[k]) && a->coeffs[k] < MLKEM_Q)) }
 */

/*
 * Prevent clang-format from corrupting CBMC's special ==> operator
 */
/* clang-format off */
#define CBMC_CONCAT_(left, right) left##right
#define CBMC_CONCAT(left, right) CBMC_CONCAT_(left, right)

#define array_bound_core(qvar, qvar_lb, qvar_ub, array_var,            \
                         value_lb, value_ub)                           \
  __CPROVER_forall                                                     \
  {                                                                    \
    uint32_t qvar;                                                     \
    ((uint32_t) (qvar_lb) <= (qvar) && (qvar) < (uint32_t) (qvar_ub)) ==> \
        (((int)(value_lb) <= ((array_var)[(qvar)])) &&                 \
         (((array_var)[(qvar)]) < (int)(value_ub)))                    \
  }

#define array_bound(array_var, qvar_lb, qvar_ub, value_lb, value_ub)    \
  array_bound_core(CBMC_CONCAT(_cbmc_idx, __COUNTER__), (qvar_lb),      \
      (qvar_ub), (array_var), (value_lb), (value_ub))

#define array_unchanged_core(qvar, qvar_lb, qvar_ub, array_var)        \
  __CPROVER_forall                                                     \
  {                                                                    \
    uint32_t qvar;                                                     \
    ((uint32_t) (qvar_lb) <= (qvar) && (qvar) < (uint32_t) (qvar_ub)) ==> \
    ((array_var)[(qvar)]) == (old(* (int16_t (*)[(qvar_ub)])(array_var)))[(qvar)] \
  }

#define array_unchanged(array_var, N) \
    array_unchanged_core(CBMC_CONCAT(_cbmc_idx, __COUNTER__), 0, (N), (array_var))

#define array_unchanged_u64_core(qvar, qvar_lb, qvar_ub, array_var)    \
  __CPROVER_forall                                                     \
  {                                                                    \
    uint32_t qvar;                                                     \
    ((uint32_t) (qvar_lb) <= (qvar) && (qvar) < (uint32_t) (qvar_ub)) ==> \
    ((array_var)[(qvar)]) == (old(* (uint64_t (*)[(qvar_ub)])(array_var)))[(qvar)] \
  }

#define array_unchanged_u64(array_var, N) \
    array_unchanged_u64_core(CBMC_CONCAT(_cbmc_idx, __COUNTER__), 0, (N), (array_var))

#define array_unchanged_u8_core(qvar, array_var, N)                     \
  forall(qvar, 0, (N),                                                  \
    ((array_var)[(qvar)]) == (old(* (uint8_t (*)[(N)])(array_var)))[(qvar)])

#define array_unchanged_u8(array_var, N) \
    array_unchanged_u8_core(CBMC_CONCAT(_cbmc_idx, __COUNTER__), (array_var), (N))

#define array_zeroized_u8_core(qvar, array_var, N) \
    forall(qvar, 0, (N), ((array_var)[(qvar)]) == 0)

#define array_zeroized_u8(array_var, N) \
    array_zeroized_u8_core(CBMC_CONCAT(_cbmc_idx, __COUNTER__), (array_var), (N))
/* clang-format on */

/*
 * Output-buffer discipline on failure, as documented in API-CONVENTIONS.md:
 * when a function fails, each caller-owned output buffer is left either
 * fully unchanged or fully zeroized -- never holding partially computed or
 * stale data that could be mistaken for a valid result.
 *
 * Note the disjunction is over the buffer as a whole: it is not enough for
 * each byte to be individually either unchanged or zero.
 */
#define array_unchanged_or_zeroized_u8(array_var, N) \
  (array_unchanged_u8((array_var), (N)) || array_zeroized_u8((array_var), (N)))

/* Wrapper around array_bound operating on absolute values.
 *
 * The absolute value bound `k` is exclusive.
 *
 * Note that since the lower bound in array_bound is inclusive, we have to
 * raise it by 1 here.
 */
#define array_abs_bound(arr, lb, ub, k) \
  array_bound((arr), (lb), (ub), -((int)(k)) + 1, (k))

#endif /* CBMC */

#endif /* !MLK_CBMC_H */
