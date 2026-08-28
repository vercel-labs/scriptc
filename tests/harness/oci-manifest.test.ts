import { expect, test } from "vitest";
import { linuxAmd64ManifestDigest } from "../../scripts/oci-manifest.mjs";

const digest = (character: string): string => `sha256:${character.repeat(64)}`;

test("selects the linux/amd64 child descriptor from an image index", () => {
  expect(
    linuxAmd64ManifestDigest({
      manifest: {
        mediaType: "application/vnd.oci.image.index.v1+json",
        digest: digest("a"),
        manifests: [
          {
            digest: digest("b"),
            platform: { os: "linux", architecture: "arm64" },
          },
          {
            digest: digest("c"),
            platform: { os: "linux", architecture: "amd64" },
          },
        ],
      },
    }),
  ).toBe(digest("c"));
});

test("selects a direct image manifest descriptor, never its config blob", () => {
  expect(
    linuxAmd64ManifestDigest({
      manifest: {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: digest("d"),
        config: { digest: digest("e") },
      },
    }),
  ).toBe(digest("d"));
});

test("rejects an index without a linux/amd64 descriptor", () => {
  expect(() =>
    linuxAmd64ManifestDigest({
      manifest: {
        mediaType: "application/vnd.oci.image.index.v1+json",
        digest: digest("f"),
        manifests: [],
      },
    }),
  ).toThrow("could not find a linux/amd64 image manifest descriptor");
});
