import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { builtinImportOf } from "./module-bindings.js";

export function isConsoleLog(lowerer: Lowerer, call: ts.CallExpression): boolean {
  return consoleCallMember(lowerer, call) === "log";
}

/** The output members: "log"/"info"/"debug" (stdout — Node's info and
 * debug ARE log under other names), and "error"/"warn" (both stderr —
 * Node's warn IS error under another name; the output is identical). */
export type ConsoleOutputMember = "log" | "info" | "debug" | "error" | "warn";

/** The rest of the lowered global console surface (lower-console.ts):
 * counters, timers, groups, assert, dir/dirxml, table, clear, and the
 * inspector-only profile/profileEnd/timeStamp. trace stays fenced (its
 * stack frames name Node's own module loader). */
export type ConsoleMethodMember =
  | "assert"
  | "clear"
  | "count"
  | "countReset"
  | "dir"
  | "dirxml"
  | "group"
  | "groupCollapsed"
  | "groupEnd"
  | "profile"
  | "profileEnd"
  | "table"
  | "time"
  | "timeEnd"
  | "timeLog"
  | "timeStamp";

const CONSOLE_METHOD_MEMBERS: ReadonlySet<string> = new Set<ConsoleMethodMember>([
  "assert",
  "clear",
  "count",
  "countReset",
  "dir",
  "dirxml",
  "group",
  "groupCollapsed",
  "groupEnd",
  "profile",
  "profileEnd",
  "table",
  "time",
  "timeEnd",
  "timeLog",
  "timeStamp",
]);

/** The console member of a `console.<member>(...)` call, for the lowered
 * output set (see ConsoleOutputMember). Provenance-checked like every
 * stdlib global. Null for anything else (console.table, a user's own
 * console binding, ...). */
export function consoleCallMember(
  lowerer: Lowerer,
  call: ts.CallExpression,
): ConsoleOutputMember | null {
  const member = consoleMemberOf(lowerer, call, isConsoleOutputMember);
  return member !== null && isConsoleOutputMember(member) ? member : null;
}

/** The member of a global-console call outside the output set that has
 * a lowering (see ConsoleMethodMember); null otherwise. */
export function consoleMethodMember(
  lowerer: Lowerer,
  call: ts.CallExpression,
): ConsoleMethodMember | null {
  const member = consoleMemberOf(lowerer, call, (name) => CONSOLE_METHOD_MEMBERS.has(name));
  return member as ConsoleMethodMember | null;
}

function consoleMemberOf(
  lowerer: Lowerer,
  call: ts.CallExpression,
  accepts: (name: string) => boolean,
): string | null {
  if (call.questionDotToken) return null;
  if (ts.isIdentifier(call.expression)) {
    const imported = builtinImportOf(lowerer, call.expression);
    return imported?.module === "console" && accepts(imported.member) ? imported.member : null;
  }
  if (!ts.isPropertyAccessExpression(call.expression)) return null;
  const access = call.expression;
  if (access.questionDotToken || call.questionDotToken) return null;
  const name = access.name.text;
  if (!accepts(name)) return null;
  return lowerer.isStdlibGlobal(access.expression, "console") ||
    lowerer.builtinNamespaceModuleOf(access.expression) === "console"
    ? name
    : null;
}

/** Whether a direct `console.<name>(...)` call has a lowering: the output
 * members and the rest of the lowered surface. `trace` and the keys that
 * are not methods do not. */
export function isLoweredConsoleMember(name: string): boolean {
  return isConsoleOutputMember(name) || CONSOLE_METHOD_MEMBERS.has(name);
}

function isConsoleOutputMember(name: string): name is ConsoleOutputMember {
  return (
    name === "log" || name === "info" || name === "debug" || name === "error" || name === "warn"
  );
}
