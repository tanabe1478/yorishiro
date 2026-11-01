import { lstat, opendir } from "node:fs/promises";
import * as path from "node:path";
import { WORKER_EVIDENCE_SUBDIR, workerEvidenceDir } from "./launcher.ts";
import { EVIDENCE_LIMITS, type EvidenceLimits } from "./verifier-tools.ts";

export { WORKER_EVIDENCE_SUBDIR, workerEvidenceDir };

/**
 * The Claude Worker writes its evidence (screenshots, observation JSON) straight
 * into `<artifact>/evidence/worker/` through YORISHIRO_EVIDENCE_DIR. Nothing is
 * copied, so this only takes an inventory with the same limits the Reviewer's
 * collection uses and says when the directory exceeds them. It never reads file
 * contents and never follows a symlink.
 */
export type WorkerEvidenceInventory = {
  dir: string;
  files: Array<{ path: string; bytes: number }>;
  bytes: number;
  visited: number;
  /** Over a limit, or holds symlinks or special files. The directory itself is left as the Worker wrote it. */
  truncated: boolean;
  skipped: Array<{ path: string; reason: string }>;
  skippedCount: number;
};

export async function inventoryWorkerEvidence(artifactDir: string, options: Partial<EvidenceLimits> = {}): Promise<WorkerEvidenceInventory> {
  const limits: EvidenceLimits = { ...EVIDENCE_LIMITS, ...options };
  const root = workerEvidenceDir(artifactDir);
  const result: WorkerEvidenceInventory = { dir: path.relative(artifactDir, root), files: [], bytes: 0, visited: 0, truncated: false, skipped: [], skippedCount: 0 };
  const skip = (relative: string, reason: string) => {
    result.skippedCount++;
    if (result.skipped.length < limits.maxSkippedDiagnostics) result.skipped.push({ path: relative, reason });
    result.truncated = true;
  };
  const rootInfo = await lstat(root).catch(() => undefined);
  if (!rootInfo) return result;
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) { skip(".", "evidence directory is not a real directory"); return result; }
  const walk = async (directory: string, relativeDir: string, depth: number) => {
    let handle: Awaited<ReturnType<typeof opendir>>;
    try { handle = await opendir(directory); } catch { skip(relativeDir || ".", "unreadable directory"); return; }
    try {
      for await (const entry of handle) {
        if (result.visited >= limits.maxEntries) { skip(relativeDir || ".", "entry limit"); return; }
        result.visited++;
        const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
        const absolute = path.join(directory, entry.name);
        const info = await lstat(absolute).catch(() => undefined);
        if (!info) { skip(relative, "unreadable entry"); continue; }
        if (info.isSymbolicLink()) { skip(relative, "symlink"); continue; }
        if (info.isDirectory()) {
          if (depth >= limits.maxDepth) { skip(relative, "depth limit"); continue; }
          await walk(absolute, relative, depth + 1);
          continue;
        }
        if (!info.isFile()) { skip(relative, "non-regular file"); continue; }
        if (result.files.length >= limits.maxFiles) { skip(relative, "file count limit"); continue; }
        if (info.size > limits.maxFileBytes) { skip(relative, "file size limit"); continue; }
        if (result.bytes + info.size > limits.maxTotalBytes) { skip(relative, "total size limit"); continue; }
        result.files.push({ path: relative, bytes: info.size });
        result.bytes += info.size;
      }
    } finally {
      await handle.close().catch(() => {});
    }
  };
  await walk(root, "", 0);
  return result;
}
