const IMAGE_MANIFEST_MEDIA_TYPES = new Set([
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
]);

/**
 * Resolve the descriptor digest VCR reports for a linux/amd64 image.
 *
 * `docker buildx imagetools inspect --format "{{json .}}"` includes the
 * canonical descriptor digest even when the tag points directly at a
 * single-platform manifest. Raw manifest JSON does not: its `config.digest`
 * names the image configuration blob, which is a different registry object.
 */
export function linuxAmd64ManifestDigest(inspection) {
  const manifest = inspection?.manifest;
  const platformManifest = manifest?.manifests?.find(
    (candidate) =>
      candidate.platform?.os === "linux" &&
      candidate.platform?.architecture === "amd64",
  );
  if (typeof platformManifest?.digest === "string") return platformManifest.digest;

  if (
    IMAGE_MANIFEST_MEDIA_TYPES.has(manifest?.mediaType) &&
    typeof manifest?.digest === "string"
  ) {
    return manifest.digest;
  }

  throw new Error("could not find a linux/amd64 image manifest descriptor");
}
