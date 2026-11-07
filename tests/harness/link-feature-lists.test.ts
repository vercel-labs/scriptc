/** The keys NativeLinkFeatures always spells (the ones declared without
 * `?`) are written once more, as the all-off value NO_LINK_FEATURES beside
 * the interface, and the lists that used to repeat them read that. These
 * tests hold it to the interface and keep another hand-written list from
 * growing back: an array or object literal in the compiler's source that
 * spells twenty or more of the interface's keys fails here unless it is one
 * of the lists named below, and so does a name below whose list is gone.
 * An optional key is listed nowhere but the interface, so adding or
 * removing one changes nothing here. */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";
import { REQUIRED_LINK_FEATURES } from "../../packages/compiler/src/backend/native-link-info-core.js";

const root = join(import.meta.dirname, "../..");
const sourceRoot = join(root, "packages/compiler/src");
const LIST_FILE = "packages/compiler/src/backend/native-link-info-core.ts";

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
}

/** The members of NativeLinkFeatures as the source declares them. */
function declaredFeatures(): { name: string; required: boolean }[] {
  const declaration = parse(join(root, LIST_FILE)).statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === "NativeLinkFeatures",
  );
  expect(declaration, `NativeLinkFeatures in ${LIST_FILE}`).toBeDefined();
  return declaration!.members.map((member) => ({
    name: (member.name as ts.Identifier).text,
    required: member.questionToken === undefined,
  }));
}

test("the required keys are listed once, in the interface's order", () => {
  const declared = declaredFeatures();
  const required = declared.filter((feature) => feature.required).map(({ name }) => name);
  const listed = new Set<string>(REQUIRED_LINK_FEATURES);
  const problems: string[] = [];
  for (const [index, name] of required.entries()) {
    if (listed.has(name)) continue;
    const place = index === 0 ? "as the first line" : `after \`${required[index - 1]}\``;
    problems.push(
      `NativeLinkFeatures declares \`${name}\` without \`?\`, so every value spells it, and NO_LINK_FEATURES (${LIST_FILE}) does not list it: add \`${name}: false,\` ${place}. The cache validators and the warm-cache profiles read that value instead of listing the keys themselves. If a program without the feature should keep its link identity, declare the key with \`?\` instead and add no line.`,
    );
  }
  for (const name of REQUIRED_LINK_FEATURES) {
    if (required.includes(name)) continue;
    problems.push(
      declared.some((feature) => feature.name === name)
        ? `NO_LINK_FEATURES lists \`${name}\`, which NativeLinkFeatures declares with \`?\`: an optional key is absent when off, so delete the line.`
        : `NO_LINK_FEATURES lists \`${name}\`, which NativeLinkFeatures does not declare: delete the line.`,
    );
  }
  expect(problems).toEqual([]);
  // Complete on both sides, so only the order is left to differ.
  expect([...REQUIRED_LINK_FEATURES]).toEqual(required);
});

/** The lists of link feature keys in the compiler's source, by file and
 * top-level declaration, each with what it is. No other array or object
 * literal may spell MANY_KEYS or more of the interface's keys. */
const LISTS: Readonly<Record<string, string>> = {
  "backend/native-link-info-core.ts#NO_LINK_FEATURES": "the list of the required keys itself",
  "backend/library-pack.ts#libraryArchiveFeatures":
    "the library archive's gates, written over every required key; open changes append to this literal, so it starts from noLinkFeatures() once they have landed (library-pack.test.ts holds it to the list until then)",
  "backend/executable-features.ts#executableLinkFeatures":
    "maps each IR fact to its link feature: five names differ, some features are computed from several facts or from the module, and its key order is the one cache keys carry",
  "index.ts#compileExecutableNative":
    "copies the link features onto the options of the build that compiles the runtime from source",
  "backend/runtime-pack-core.ts#effectiveRuntimeFeatures":
    "turns absent optional keys into false for the pack's predicates and adds the computed features",
  "ir/runtime-features.ts#RUNTIME_FEATURE_RULES":
    "the IR facts and their rules: another set of names, most of them shared with the link features",
  "ir/runtime-features.ts#noRuntimeFeatures":
    "every IR fact off, held to the rule table by its type",
};
const MANY_KEYS = 20;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts"))
      out.push(path);
  }
  return out;
}

/** The feature keys an object literal names as its own properties, counting
 * the `...(on ? { key: true } : {})` form an optional key is written in. */
function objectKeys(node: ts.ObjectLiteralExpression, keys: ReadonlySet<string>, out: Set<string>) {
  for (const property of node.properties) {
    if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
      const name = property.name;
      if ((ts.isIdentifier(name) || ts.isStringLiteralLike(name)) && keys.has(name.text))
        out.add(name.text);
    } else if (ts.isSpreadAssignment(property)) {
      let spread = property.expression;
      while (ts.isParenthesizedExpression(spread)) spread = spread.expression;
      if (!ts.isConditionalExpression(spread)) continue;
      for (const arm of [spread.whenTrue, spread.whenFalse])
        if (ts.isObjectLiteralExpression(arm)) objectKeys(arm, keys, out);
    }
  }
}

/** The array and object literals of a file that spell `many` or more of the
 * keys, by the top-level declaration that holds them, with the largest
 * count there. */
function listsIn(
  file: ts.SourceFile,
  keys: ReadonlySet<string>,
  many: number,
): Map<string, number> {
  const lists = new Map<string, number>();
  const visit = (node: ts.Node, owner: string): void => {
    if (node.parent === file) {
      if (ts.isVariableStatement(node))
        owner = node.declarationList.declarations.map((d) => d.name.getText(file)).join(",");
      else if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node))
        owner = node.name?.text ?? owner;
    }
    const found = new Set<string>();
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements)
        if (ts.isStringLiteralLike(element) && keys.has(element.text)) found.add(element.text);
    } else if (ts.isObjectLiteralExpression(node)) objectKeys(node, keys, found);
    if (found.size >= many) lists.set(owner, Math.max(lists.get(owner) ?? 0, found.size));
    ts.forEachChild(node, (child) => visit(child, owner));
  };
  visit(file, "(module)");
  return lists;
}

/** Every list of MANY_KEYS or more of the keys in the compiler's source, as
 * `file#top-level declaration`. */
function listCensus(keys: ReadonlySet<string>): Map<string, number> {
  const census = new Map<string, number>();
  const word = /[A-Za-z_$][\w$]*/g;
  for (const path of sourceFiles(sourceRoot)) {
    // A file whose text has fewer than MANY_KEYS of the keys as words holds
    // no such list, and most files do: only the others are parsed.
    const words = new Set(readFileSync(path, "utf8").match(word));
    let present = 0;
    for (const key of keys) if (words.has(key)) present++;
    if (present < MANY_KEYS) continue;
    const name = relative(sourceRoot, path).split("\\").join("/");
    for (const [owner, count] of listsIn(parse(path), keys, MANY_KEYS))
      census.set(`${name}#${owner}`, count);
  }
  return census;
}

test("no other list in the compiler spells the link feature keys", () => {
  const census = listCensus(new Set(declaredFeatures().map(({ name }) => name)));
  const unexpected = [...census]
    .filter(([site]) => LISTS[site] === undefined)
    .map(
      ([site, count]) =>
        `${site} writes out ${count} keys of NativeLinkFeatures. The required keys are listed once, as NO_LINK_FEATURES in ${LIST_FILE}: read their names from REQUIRED_LINK_FEATURES (as the cache validators do), or start from noLinkFeatures() and turn on what is linked (as the warm-cache profiles do), and leave optional keys out.`,
    );
  expect(unexpected).toEqual([]);
  // A name here outlives its list only by mistake: delete the entry of a
  // list that is gone, so the next list in that place is seen.
  const gone = Object.keys(LISTS).filter((site) => !census.has(site));
  expect(gone).toEqual([]);
});

test("the census sees a list in each form it is written in", () => {
  const file = ts.createSourceFile(
    "sample.ts",
    `const names = ["regex", "fetch", "other"];
     function features(on: boolean) {
       const few = { regex: on };
       return { regex: false, "fetch": on, ...(on ? { wasm: true } : {}), other: few };
     }`,
    ts.ScriptTarget.Latest,
    true,
  );
  expect([...listsIn(file, new Set(["regex", "fetch", "wasm"]), 2)]).toEqual([
    ["names", 2],
    ["features", 3],
  ]);
});
