// A module wrapping node:fs: library imports resolve through import aliases
// in non-entry modules exactly like in the entry file.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";

export function scratchDir(tag: string): string {
  const script = process.argv[1];
  let i = script.length - 1;
  while (i >= 0 && script.charAt(i) !== "/" && script.charAt(i) !== "\\") {
    i = i - 1;
  }
  const dir = tag + script.slice(i + 1) + "-" + process.pid;
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      rmSync(dir + "/" + name);
    }
    rmdirSync(dir);
  }
  mkdirSync(dir);
  return dir;
}

export function saveLine(dir: string, name: string, line: string): void {
  const path = dir + "/" + name;
  if (existsSync(path)) {
    appendFileSync(path, line + "\n");
  } else {
    writeFileSync(path, line + "\n");
  }
}

export function countLines(dir: string, name: string): number {
  const text = readFileSync(dir + "/" + name, "utf8");
  let lines = 0;
  for (let i = 0; i < text.length; i = i + 1) {
    if (text.charAt(i) === "\n") {
      lines = lines + 1;
    }
  }
  return lines;
}

export function cleanup(dir: string): void {
  for (const name of readdirSync(dir)) {
    rmSync(dir + "/" + name);
  }
  rmdirSync(dir);
}
