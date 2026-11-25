// A spread merge over UNION-typed sources: `{ ...base, ...override }` has one
// field set per combination of source arms, so the merged value can carry
// fields from several arms at once. No single arm of the destination union
// can represent it (naming one would drop the other arms' fields, which Node
// keeps), and no runtime tag would be honest. The refusal names the candidate
// arms; the repair is one arm per merge or one open all-optional record type.
//
// This fixture pins the refusal under `--tier=static-only`. The default tier
// builds the object Node builds instead — a checked-dynamic copy whose keys
// are written in source order and validated at each typed slot (see
// tests/corpus/union-spread-merge.ts and the dyncheck fixture
// "union spread merge") — so it is static-only that keeps this diagnostic.
interface OpenAiCompat {
  kind: "openai";
  supportsStore?: boolean;
}

interface AnthropicCompat {
  kind: "anthropic";
  supportsLongCacheRetention?: boolean;
}

type Compat = OpenAiCompat | AnthropicCompat;

function mergeCompat(base: Compat | undefined, override: Compat | undefined): Compat | undefined {
  if (!override) return base;
  const merged = { ...base, ...override } as NonNullable<Compat>;
  return merged;
}

const result = mergeCompat({ kind: "openai" }, { kind: "anthropic" });
console.log(result !== undefined);
