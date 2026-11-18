[//]: # (SPDX-License-Identifier: CC-BY-4.0)

# mlkem-native source tree

This is the main source tree of mlkem-native.

## Building

To build a mlkem-native for a fixed parameter set (ML-KEM-512/768/1024), build the compilation in units in `src/*` separately, and link to an RNG and your application. See [examples/basic](../examples/basic) for a simple example.

Alternatively, you can use the auto-generated helper files [mlkem_native.c](mlkem_native.c) and [mlkem_native_asm.S](mlkem_native_asm.S), which bundle all *.c and *.S files together. See [examples/monolithic_build](../examples/monolithic_build) and [examples/monolithic_build_native](../examples/monolithic_build_native) for examples without and with native code.

## Configuration

The build is configured by [mlkem_native_config.h](mlkem_native_config.h), or by the file pointed to by `MLK_CONFIG_FILE`. Note in particular `MLK_CONFIG_PARAMETER_SET` and `MLK_CONFIG_NAMESPACE_PREFIX`, which set the parameter set and namespace prefix, respectively.

## API

The public API is defined in [mlkem_native.h](mlkem_native.h).

## Supporting multiple parameter sets

If you want to support multiple parameter sets, build the library once per parameter set you want to support. Set `MLK_CONFIG_MULTILEVEL_BUILD` for all of these builds; this is what appends the parameter set to the namespace prefix, keeping the level-specific symbols apart. To avoid duplicating shared functionality, additionally set `MLK_CONFIG_MULTILEVEL_WITH_SHARED` for exactly one of the builds, and `MLK_CONFIG_MULTILEVEL_NO_SHARED` for the others. Finally, link with RNG and your application as before. This is demonstrated in the examples [examples/multilevel_build](../examples/multilevel_build), [examples/multilevel_build_native](../examples/multilevel_build_native), [examples/monolithic_build_multilevel](../examples/monolithic_build_multilevel) and [examples/monolithic_build_multilevel_native](../examples/monolithic_build_multilevel_native).
