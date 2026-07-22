import type { ArtifactStore, BlobStore, ProjectRepository } from '@agent-foundry/domain';
import { blobKeyFor } from '@agent-foundry/composition';

/**
 * Deletes blob-store objects that no artifact metadata references and that
 * are older than the grace period. The grace window is what makes an
 * in-flight write (revision allocated, bytes uploaded, metadata write still
 * pending or crashed) safe: it stays invisible to readers but isn't swept
 * until it's had time to either finish or be recognized as abandoned.
 * Knowledge indexes deliberately do not participate: their upload revisions
 * remain ordinary artifact metadata even after an active entry is removed.
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
    runtime.projects.listAll(),
  ]);

  const metadataByProject = await Promise.all(
    projects.map((project) => runtime.artifacts.listMetadata(project.id)),
  );
  const referenced = new Set<string>();
  for (const metadata of metadataByProject) {
    for (const item of metadata) {
      if (item.storage === 'blob' && !item.blobDeleted) {
        referenced.add(blobKeyFor(item.projectId, item.name, item.revision));
      }
    }
  }

  const cutoffMs = now.getTime() - graceMs;
  const stale = blobs.filter(
    (blob) => !referenced.has(blob.key) && Date.parse(blob.createdAt) <= cutoffMs,
  );
  const results = await Promise.allSettled(stale.map((blob) => runtime.blobStore.delete(blob.key)));
  return results.filter((result) => result.status === 'fulfilled').length;
}
