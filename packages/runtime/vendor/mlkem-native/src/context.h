/*
 * Copyright (c) The mlkem-native project authors
 * SPDX-License-Identifier: Apache-2.0 OR ISC OR MIT
 */
#ifndef MLK_CONTEXT_H
#define MLK_CONTEXT_H

/* This header is included by common.h once the configuration has been pulled
 * in; it is not meant to be included directly. */

/*
 * If the integration wants to provide a context parameter for use in
 * platform-specific hooks, then it should define this parameter.
 *
 * The MLK_CONTEXT_PARAMETERS_n macros are intended to be used with macros
 * defining the function names and expand to either pass or discard the context
 * argument as required by the current build.  If there is no context parameter
 * requested then these are removed from the prototypes and from all calls.
 */
#ifdef MLK_CONFIG_CONTEXT_PARAMETER
#define MLK_CONTEXT_PARAMETERS_0(context) (context)
#define MLK_CONTEXT_PARAMETERS_1(arg0, context) (arg0, context)
#define MLK_CONTEXT_PARAMETERS_2(arg0, arg1, context) (arg0, arg1, context)
#define MLK_CONTEXT_PARAMETERS_3(arg0, arg1, arg2, context) \
  (arg0, arg1, arg2, context)
#define MLK_CONTEXT_PARAMETERS_4(arg0, arg1, arg2, arg3, context) \
  (arg0, arg1, arg2, arg3, context)
#else /* MLK_CONFIG_CONTEXT_PARAMETER */
#define MLK_CONTEXT_PARAMETERS_0(context) ()
#define MLK_CONTEXT_PARAMETERS_1(arg0, context) (arg0)
#define MLK_CONTEXT_PARAMETERS_2(arg0, arg1, context) (arg0, arg1)
#define MLK_CONTEXT_PARAMETERS_3(arg0, arg1, arg2, context) (arg0, arg1, arg2)
#define MLK_CONTEXT_PARAMETERS_4(arg0, arg1, arg2, arg3, context) \
  (arg0, arg1, arg2, arg3)
#endif /* !MLK_CONFIG_CONTEXT_PARAMETER */

/* Consume a context parameter carried only for the integration's benefit,
 * avoiding -Wunused-parameter; expands to nothing when no context is
 * configured. */
#if defined(MLK_CONFIG_CONTEXT_PARAMETER)
#define MLK_CONTEXT_UNUSED(context) ((void)(context))
#else
#define MLK_CONTEXT_UNUSED(context) ((void)0)
#endif

#if defined(MLK_CONFIG_CONTEXT_PARAMETER_TYPE) != \
    defined(MLK_CONFIG_CONTEXT_PARAMETER)
#error MLK_CONFIG_CONTEXT_PARAMETER_TYPE must be defined if and only if MLK_CONFIG_CONTEXT_PARAMETER is defined
#endif

#endif /* !MLK_CONTEXT_H */
