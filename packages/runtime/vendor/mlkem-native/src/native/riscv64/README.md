[//]: # (SPDX-License-Identifier: CC-BY-4.0)

# RISC-V Vector Extension Backend

This is an arithmetic backend for CPUs implementing the RISC-V Vector Extension. The backend is functional for all physical `VLEN`, but the NTT and inverse NTT are so far only implemented for VLEN=256, falling back to the default C implementations for other VLENs.

## Requirements

- RISC-V 64-bit architecture
- Vector extension (RVV) version 1.0
- Standard "gc" extensions (integer and compressed instructions)
