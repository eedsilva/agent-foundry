import type { ArtifactStore, BlobStore, ProjectRepository } from '@agent-foundry/domain';
import { blobKeyFor } from '@agent-foundry/composition';

/**
 * Deletes blob-store objects that no artifact metadata references and that
 * are older than the grace period. The grace window is what makes an
 * in-flight write (revision allocated, bytes uploaded, metadata write still
 * pending or crashed) safe: it stays invisible to readers but isn't swept
 * until it's had time to either finish or be recognized as abandoned.
 *
 * ponytail: lists every project and every artifact revision each sweep
 * (O(projects x artifacts)). Fine at this project's scale; an index keyed by
 * blob key would be the upgrade if that ever shows up in a profile.
 */
export async function sweepUnreferencedBlobs(
  runtime: { blobStore: BlobStore; artifacts: ArtifactStore; projects: ProjectRepository },
  graceMs: number,
  now: Date,
): Promise<number> {
  const [blobs, projects] = await Promise.all([
    runtime.blobStore.list('projects/'),
    runtime.projects.list(Number.MAX_SAFE_INTEGER),
  ]);

  const referenced = new Set<string>();
  for (const project of projects) {
    const metadata = await runtime.artifacts.listMetadata(project.id);
    for (const item of metadata) {
      if (item.storage === 'blob' && !item.blobDeleted) {
        referenced.add(blobKeyFor(project.id, item.name, item.revision));
      }
    }
  }

  const cutoffMs = now.getTime() - graceMs;
  let deleted = 0;
  for (const blob of blobs) {
    if (referenced.has(blob.key)) continue;
    if (Date.parse(blob.createdAt) > cutoffMs) continue;
    await runtime.blobStore.delete(blob.key);
    deleted += 1;
  }
  return deleted;
}
