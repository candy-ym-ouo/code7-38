import type { PrivacyRegion } from "@map/shared/contracts";
import {
  MediaPublishError,
  mediaPublicKeys,
  publishMediaObjects,
  type PublishPlan
} from "@map/shared/media-publish";
import { config } from "./config";
import { pool } from "./db";
import { deleteObject, objectExists, readQuarantineObject, writeQuarantineObject } from "./storage";
import { scanForMalware } from "./clamav";
import { processPrivacyImage } from "./privacy";
import { buildWorkerPublishPorts } from "./media-publish-ports";

/** Remove both deterministic public copies; S3 deletes on missing keys are benign. */
async function deletePublicCopies(mediaId: string): Promise<void> {
  const keys = mediaPublicKeys(mediaId);
  await Promise.all([
    deleteObject(config.S3_PUBLIC_BUCKET, keys.image),
    deleteObject(config.S3_PUBLIC_BUCKET, keys.thumbnail)
  ]);
}

export async function processMediaJob(mediaId: string): Promise<void> {
  // Atomic pipeline claim. Two queue jobs for the same media race here; only
  // the winning UPDATE drives processing and publishing.
  const claim = await pool.query<{
    quarantine_object_key: string;
    privacy_report: { manualRegions?: PrivacyRegion[] } | null;
  }>(
    `UPDATE media_assets
     SET privacy_status = 'scanning', updated_at = now()
     WHERE id = $1 AND privacy_status IN ('processing', 'failed') AND deleted_at IS NULL
     RETURNING quarantine_object_key, privacy_report`,
    [mediaId]
  );
  const media = claim.rows[0];
  if (!media) {
    console.log(`skip media ${mediaId}: already claimed or not processable`);
    return;
  }

  const autoPublish = Boolean(config.PRIVACY_DETECTOR_URL);

  try {
    const source = await readQuarantineObject(media.quarantine_object_key);
    await scanForMalware(source);

    const manualRegions = media.privacy_report?.manualRegions ?? [];
    const processed = await processPrivacyImage(source, manualRegions);

    const processedKey = `processed/${mediaId}.webp`;
    const thumbnailKey = `processed/${mediaId}.thumb.webp`;
    await writeQuarantineObject(processedKey, processed.image, "image/webp");
    await writeQuarantineObject(thumbnailKey, processed.thumbnail, "image/webp");

    const report = {
      manualRegions: processed.manualRegions,
      detectorRegions: processed.detectorRegions,
      detectorConfigured: autoPublish,
      originalMetadataRemoved: true,
      serverReencoded: true,
      width: processed.width,
      height: processed.height,
      sha256: processed.sha256,
      perceptualHash: processed.perceptualHash,
      completedAt: new Date().toISOString()
    };

    // Persist processed artifacts before touching the public bucket. The
    // conditional status acts as a fencing token: if stale-job recovery handed
    // the row to another job, this update affects nothing and we stop.
    const persisted = await pool.query(
      `UPDATE media_assets
       SET privacy_status = $2,
           processed_object_key = $3,
           thumbnail_object_key = $4,
           width = $5,
           height = $6,
           sha256 = $7,
           perceptual_hash = $8,
           privacy_report = $9::jsonb,
           failure_code = NULL,
           processed_at = now(),
           delete_after = now() + ($10::text || ' hours')::interval,
           updated_at = now()
       WHERE id = $1 AND privacy_status = 'scanning' AND deleted_at IS NULL`,
      [
        mediaId,
        autoPublish ? "processing" : "manual_review",
        processedKey,
        thumbnailKey,
        processed.width,
        processed.height,
        processed.sha256,
        processed.perceptualHash,
        JSON.stringify(report),
        String(config.ORIGINAL_RETENTION_HOURS)
      ]
    );
    if (!persisted.rowCount) {
      console.log(`media ${mediaId}: lost ownership before publishing; another job owns it`);
      return;
    }

    if (!autoPublish) {
      console.log(`media ${mediaId} processed as manual_review`);
      return;
    }

    const keys = mediaPublicKeys(mediaId);
    const plan: PublishPlan = {
      mediaId,
      fromStates: ["processing"],
      objects: [
        { slot: "image", sourceKey: processedKey, publicKey: keys.image },
        { slot: "thumbnail", sourceKey: thumbnailKey, publicKey: keys.thumbnail }
      ]
    };
    await publishMediaObjects(buildWorkerPublishPorts(mediaId), plan, { abortState: "failed" });
    console.log(`media ${mediaId} processed as ready`);
  } catch (error) {
    if (error instanceof MediaPublishError) {
      if (error.stage === "claim") {
        // Another publisher holds the claim; it owns the outcome.
        console.log(`media ${mediaId}: publish claim lost to a concurrent publisher`);
        return;
      }
      // The state machine already removed what this attempt published and set
      // the final state (or left the row in publishing for reconciliation).
      throw error;
    }

    const message = error instanceof Error ? error.message.slice(0, 500) : "Unknown media processing error";
    await pool.query(
      `UPDATE media_assets
       SET privacy_status = 'failed',
           failure_code = $2,
           delete_after = now() + interval '7 days',
           updated_at = now()
       WHERE id = $1 AND privacy_status IN ('scanning', 'processing') AND deleted_at IS NULL`,
      [mediaId, message]
    );
    throw error;
  }
}

/**
 * Reconcile rows stuck in `publishing`: the API/worker process died while
 * copying public objects, or its compensation delete itself failed. Public
 * copies must be removed BEFORE releasing the claim, so a privacy-unconfirmed
 * object can never remain reachable in the public bucket.
 */
export async function recoverStuckPublishing(): Promise<void> {
  const stuck = await pool.query<{ id: string; processed_object_key: string | null }>(
    `SELECT id, processed_object_key FROM media_assets
     WHERE privacy_status = 'publishing'
       AND updated_at < now() - interval '10 minutes'
       AND deleted_at IS NULL
     LIMIT 50`
  );
  for (const row of stuck.rows) {
    try {
      await deletePublicCopies(row.id);
      if (row.processed_object_key) {
        // Safe fallback: the blurred output exists privately, send it back to
        // a human for confirmation instead of auto-publishing after a crash.
        await pool.query(
          `UPDATE media_assets
           SET privacy_status = 'manual_review', failure_code = NULL, updated_at = now()
           WHERE id = $1 AND privacy_status = 'publishing'`,
          [row.id]
        );
      } else {
        await pool.query(
          `UPDATE media_assets
           SET privacy_status = 'failed',
               failure_code = 'RECOVERED_FROM_STUCK_PUBLISH',
               delete_after = now() + interval '7 days',
               updated_at = now()
           WHERE id = $1 AND privacy_status = 'publishing'`,
          [row.id]
        );
      }
    } catch (error) {
      console.error({ mediaId: row.id, error }, "failed to recover stuck publishing media");
    }
  }
}

/**
 * Defense-in-depth sweep for public objects left behind after a failed
 * automatic publish. The state machine normally removes these before marking
 * the row failed; this covers crash windows and retries the delete until it
 * succeeds, then records that the leak was cleaned.
 */
export async function sweepLeakedPublicObjects(): Promise<void> {
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM media_assets
     WHERE privacy_status = 'failed'
       AND failure_code = 'PUBLIC_PUBLISH_FAILED'
       AND deleted_at IS NULL
     LIMIT 50`
  );
  for (const row of result.rows) {
    try {
      await deletePublicCopies(row.id);
      await pool.query(
        `UPDATE media_assets
         SET failure_code = 'PUBLIC_OBJECTS_REMOVED', updated_at = now()
         WHERE id = $1 AND failure_code = 'PUBLIC_PUBLISH_FAILED'`,
        [row.id]
      );
    } catch (error) {
      console.error({ mediaId: row.id, error }, "failed to sweep leaked public objects");
    }
  }
}

export async function cleanupOriginalMedia(): Promise<void> {
  const abandoned = await pool.query<{ id: string; quarantine_object_key: string }>(
    `SELECT id, quarantine_object_key FROM media_assets
     WHERE privacy_status = 'quarantined'
       AND created_at < now() - interval '24 hours'
       AND deleted_at IS NULL
     LIMIT 50`
  );
  for (const row of abandoned.rows) {
    try {
      if (await objectExists(config.S3_QUARANTINE_BUCKET, row.quarantine_object_key)) {
        await deleteObject(config.S3_QUARANTINE_BUCKET, row.quarantine_object_key);
      }
      await pool.query(
        `UPDATE media_assets
         SET privacy_status = 'deleted', deleted_at = now(), updated_at = now()
         WHERE id = $1`,
        [row.id]
      );
    } catch (error) {
      console.error({ mediaId: row.id, error }, "failed to clean abandoned upload");
    }
  }

  const result = await pool.query<{ id: string; quarantine_object_key: string }>(
    `SELECT id, quarantine_object_key FROM media_assets
     WHERE delete_after IS NOT NULL AND delete_after <= now()
       AND quarantine_object_key IS NOT NULL
       AND privacy_status IN ('ready', 'manual_review', 'rejected', 'failed', 'deleted')
     LIMIT 50`
  );
  for (const row of result.rows) {
    try {
      if (await objectExists(config.S3_QUARANTINE_BUCKET, row.quarantine_object_key)) {
        await deleteObject(config.S3_QUARANTINE_BUCKET, row.quarantine_object_key);
      }
      await pool.query("UPDATE media_assets SET delete_after = NULL, updated_at = now() WHERE id = $1", [row.id]);
    } catch (error) {
      console.error({ mediaId: row.id, error }, "failed to clean original media");
    }
  }
}

export async function markStaleFeatures(): Promise<void> {
  await pool.query(
    `UPDATE map_features
     SET needs_review_at = COALESCE(needs_review_at, now()), updated_at = now()
     WHERE status = 'published' AND freshness_expires_at <= now() AND needs_review_at IS NULL`
  );
}

export async function recoverStuckMedia(): Promise<string[]> {
  const result = await pool.query<{ id: string }>(
    `UPDATE media_assets
     SET privacy_status = 'processing', failure_code = 'Recovered after worker timeout', updated_at = now()
     WHERE privacy_status IN ('scanning', 'processing')
       AND updated_at < now() - interval '20 minutes'
       AND deleted_at IS NULL
     RETURNING id`
  );
  return result.rows.map((row) => row.id);
}

export async function cleanupDeletedMediaObjects(): Promise<void> {
  const result = await pool.query<{
    id: string;
    quarantine_object_key: string;
    processed_object_key: string | null;
    thumbnail_object_key: string | null;
    public_object_key: string | null;
    public_thumbnail_object_key: string | null;
  }>(
    `SELECT id, quarantine_object_key, processed_object_key, thumbnail_object_key,
            public_object_key, public_thumbnail_object_key
     FROM media_assets
     WHERE privacy_status = 'deleted'
       AND (quarantine_object_key NOT LIKE 'deleted/%'
         OR processed_object_key IS NOT NULL
         OR thumbnail_object_key IS NOT NULL
         OR public_object_key IS NOT NULL
         OR public_thumbnail_object_key IS NOT NULL)
     LIMIT 50`
  );

  for (const item of result.rows) {
    try {
      // Deterministic keys are attempted as well because a row deleted while
      // it sat in `publishing` may have objects whose keys were never persisted
      // into the key columns. S3 deleting a missing key is a no-op.
      const keys = mediaPublicKeys(item.id);
      const publicTargets = new Set([keys.image, keys.thumbnail]);
      if (item.public_object_key) publicTargets.add(item.public_object_key);
      if (item.public_thumbnail_object_key) publicTargets.add(item.public_thumbnail_object_key);
      const quarantineTargets = new Set([`processed/${item.id}.webp`, `processed/${item.id}.thumb.webp`]);
      if (item.processed_object_key) quarantineTargets.add(item.processed_object_key);
      if (item.thumbnail_object_key) quarantineTargets.add(item.thumbnail_object_key);
      if (!item.quarantine_object_key.startsWith("deleted/")) {
        quarantineTargets.add(item.quarantine_object_key);
      }
      await Promise.all([
        ...[...publicTargets].map((key) => deleteObject(config.S3_PUBLIC_BUCKET, key)),
        ...[...quarantineTargets].map((key) => deleteObject(config.S3_QUARANTINE_BUCKET, key))
      ]);

      await pool.query(
        `UPDATE media_assets
         SET quarantine_object_key = $2,
             processed_object_key = NULL,
             thumbnail_object_key = NULL,
             public_object_key = NULL,
             public_thumbnail_object_key = NULL,
             delete_after = NULL,
             updated_at = now()
         WHERE id = $1`,
        [item.id, `deleted/${item.id}.object`]
      );
    } catch (error) {
      console.error({ mediaId: item.id, error }, "failed to clean deleted media objects");
    }
  }
}

export async function markUnreferencedMediaDeleted(): Promise<void> {
  await pool.query(
    `UPDATE media_assets ma
     SET privacy_status = 'deleted', deleted_at = now(), updated_at = now()
     WHERE ma.deleted_at IS NULL
       AND ma.created_at < now() - interval '7 days'
       AND NOT EXISTS (
         SELECT 1 FROM revision_media rm WHERE rm.media_id = ma.id
       )`
  );
}
