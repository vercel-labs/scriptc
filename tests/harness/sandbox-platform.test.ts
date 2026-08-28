import { expect, test } from "vitest";
import {
  sandboxHostSchedule,
  sandboxLaneEnv,
} from "../../scripts/sandbox-platform.mjs";

const files = ["native-a.test.ts", "native-b.test.ts"];

test("Darwin runs native files and kqueue contracts locally", () => {
  expect(sandboxHostSchedule("darwin", files)).toEqual({
    darwinContracts: true,
    localArtifactContracts: true,
    localInvariantFiles: files,
    remoteArtifactContracts: false,
    remoteInvariantFiles: [],
  });
});

test("Linux runs its supported native files locally without Darwin contracts", () => {
  expect(sandboxHostSchedule("linux", files)).toEqual({
    darwinContracts: false,
    localArtifactContracts: true,
    localInvariantFiles: files,
    remoteArtifactContracts: false,
    remoteInvariantFiles: [],
  });
});

test("other hosts retain native-file coverage in Linux Sandboxes", () => {
  expect(sandboxHostSchedule("win32", files)).toEqual({
    darwinContracts: false,
    localArtifactContracts: false,
    localInvariantFiles: [],
    remoteArtifactContracts: true,
    remoteInvariantFiles: files,
  });
});

test("lane environments override inherited sanitizer and scheduler settings", () => {
  expect(sandboxLaneEnv("plain")).toEqual({
    CI: "1",
    SCRIPTC_PORTABLE_ONLY: "",
    SCRIPTC_SAN: "",
    SCRIPTC_TEST_SHARD: "",
  });
  expect(sandboxLaneEnv("san")).toEqual({
    CI: "1",
    SCRIPTC_PORTABLE_ONLY: "",
    SCRIPTC_SAN: "1",
    SCRIPTC_TEST_SHARD: "",
  });
});
