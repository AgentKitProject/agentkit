export interface ArtifactNameMetadata {
  id?: string;
  version?: string;
}

export function sanitizeArtifactName(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "") || "agentkit"
  );
}

export function getDefaultOneFileName(manifestOrMetadata: ArtifactNameMetadata): string {
  const id = sanitizeArtifactName(manifestOrMetadata.id ?? "agentkit");
  const version = sanitizeArtifactName(manifestOrMetadata.version ?? "0.1.0");
  return `${id}-${version}.onefile.md`;
}

export function getDefaultPackageName(manifestOrMetadata: ArtifactNameMetadata): string {
  const id = sanitizeArtifactName(manifestOrMetadata.id ?? "agentkit");
  const version = sanitizeArtifactName(manifestOrMetadata.version ?? "0.1.0");
  return `${id}-${version}.agentkit.zip`;
}

export function getDefaultOutputName(
  manifestOrMetadata: ArtifactNameMetadata,
  timestamp: Date = new Date()
): string {
  const id = sanitizeArtifactName(manifestOrMetadata.id ?? "agentkit");
  return `${id}-output-${formatTimestamp(timestamp)}.md`;
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replaceAll("-", "").replaceAll(":", "").replace(/\.\d{3}Z$/, "Z");
}
