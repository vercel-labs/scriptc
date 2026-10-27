/** Runtime enums generated from the pinned TypeScript 7 declarations.
 * Their nominal names and values match the SDK; TypeScript 5 remains a
 * separate world. No package loader runs on the compiler's native path. */
import { jsxEmitName } from "./enums.generated.js";

export * from "./enums.generated.js";

/** The tsconfig spelling of a `jsx` option value: "preserve", "react-native",
 * "react", "react-jsx" or "react-jsxdev". */
export function jsxOptionName(value: number): string | undefined {
  switch (jsxEmitName(value)) {
    case "Preserve":
      return "preserve";
    case "ReactNative":
      return "react-native";
    case "React":
      return "react";
    case "ReactJSX":
      return "react-jsx";
    case "ReactJSXDev":
      return "react-jsxdev";
    default:
      return undefined;
  }
}
