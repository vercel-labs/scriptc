[//]: # (SPDX-License-Identifier: CC-BY-4.0)

# AArch64 backend (little endian)

This directory contains a native backend for little endian AArch64 systems. It is derived from [^NeonNTT] [^SLOTHY_Paper].

The code in this directory is auto-generated from the 'clean' assembly in [dev/aarch64_clean](../../../../dev/aarch64_clean)
in a two-step fashion: First, it is superoptimized using the [SLOTHY](https://github.com/slothy-optimizer/slothy) superoptimizer,
giving the assembly in [dev/aarch64_opt](../../../../dev/aarch64_opt). Then, it is stripped of remaining register aliases, macros
and most preprocessor directives by [`scripts/simpasm`](../../../../scripts/simpasm).

If you want to understand how the assembly works, and/or make changes to it, consult [dev/](../../../../dev).

<!--- bibliography --->
[^NeonNTT]: Becker, Hwang, Kannwischer, Yang, Yang: Neon NTT: Faster Dilithium, Kyber, and Saber on Cortex-A72 and Apple M1, [https://eprint.iacr.org/2021/986](https://eprint.iacr.org/2021/986)
[^SLOTHY_Paper]: Abdulrahman, Becker, Kannwischer, Klein: Fast and Clean: Auditable high-performance assembly via constraint solving, [https://eprint.iacr.org/2022/1303](https://eprint.iacr.org/2022/1303)
