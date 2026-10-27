import { classify, NodeKind } from "@gtdyn/estree";

export function describe(text: string): string {
  const kind = classify(text);
  return kind === NodeKind.Literal ? `literal ${text}` : `${kind} ${text}`;
}
