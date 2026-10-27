import { expect, test } from "vitest";
import { frontendProcessExecArgv } from "./frontend-process-args.js";

test("the frontend process keeps heap limits and loaders", () => {
  expect(
    frontendProcessExecArgv([
      "--max-old-space-size=8192",
      "--stack-size=4000",
      "--import",
      "tsx",
      "-r",
      "./setup.cjs",
      "--conditions=development",
      "--enable-source-maps",
    ]),
  ).toEqual([
    "--max-old-space-size=8192",
    "--stack-size=4000",
    "--import",
    "tsx",
    "-r",
    "./setup.cjs",
    "--conditions=development",
    "--enable-source-maps",
  ]);
});

test("the frontend process drops evaluated code, inspectors, watch and test runner options", () => {
  expect(
    frontendProcessExecArgv([
      "--max-old-space-size=8192",
      "--input-type=module",
      "--eval",
      "await compile(process.argv[1], {})",
    ]),
  ).toEqual(["--max-old-space-size=8192"]);
  expect(frontendProcessExecArgv(["-e", "code", "-p", "code", "-pe", "code"])).toEqual([]);
  expect(
    frontendProcessExecArgv(["--eval=code", "--print=code", "--input-type", "module"]),
  ).toEqual([]);
  expect(
    frontendProcessExecArgv([
      "--inspect",
      "--inspect-brk=9229",
      "--inspect-port",
      "9230",
      "--watch",
      "--watch-path=src",
      "--test",
      "--test-name-pattern",
      "build",
      "--test-reporter=spec",
      "--expose-gc",
    ]),
  ).toEqual(["--expose-gc"]);
});
