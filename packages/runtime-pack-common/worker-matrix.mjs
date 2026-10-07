/** Worker executables use the same runtime ABI with context-local state.
 * Every selected runtime object must agree on TLS, including optional units.
 * Ordinary and library executables retain their existing object variants. */
export function withWorkerRuntimeVariants(matrix) {
  if (matrix.target.object_format === "wasm") return matrix;
  const sources = ["scr_worker.c", "scr_worker_events.c", "scr_mailbox.c", "scr_message.c"];
  return {
    ...matrix,
    runtime_units: [
      ...matrix.runtime_units.map((unit) => ({
        ...unit,
        variants: unit.variants.flatMap((variant) => [
          { ...variant, when: { ...variant.when, workers: false } },
          ...(variant.defines.includes("SCR_DYNAMIC")
            ? []
            : [
                {
                  ...variant,
                  id: `${variant.id}-workers`,
                  when: { ...variant.when, workers: true },
                  defines: [...variant.defines, "SCR_WORKERS"],
                },
              ]),
        ]),
      })),
      ...sources.map((source) => ({
        source,
        predicate: "workers",
        variants: [{ id: "workers", when: { workers: true }, defines: ["SCR_WORKERS"] }],
      })),
    ],
  };
}
