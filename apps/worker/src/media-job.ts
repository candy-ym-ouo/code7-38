import type { PrivacyRegion } from "@map/shared/contracts";
import { processedMediaObjectKeys, publicMediaObjectKeys } from "@map/shared/media-state";
import { config } from "./config";
import { pool } from "./db";
import { deleteObject, objectExists, readQuarantineObject, writeQuarantineObject, copyToPublic } from "./storage";
import { scanForMalware } from "./clamav";
import { processPrivacyImage } from "./privacy";

export async function processMediaJob(mediaId: string): Promise<void> {
  const result = await pool.query<{
    id: string;
    privacy_status: string;
    quarantine_object_key: string;
    privacy_report: { manualRegions?: PrivacyRegion[] } | null;
  }>(
    `SELECT id, privacy_status, quarantine_object_key, privacy_report
     FROM media_assets WHERE id = $1 AND deleted_at IS NULL`,
    [mediaId]
  );
  const media = result.rows[0];
  if (!media) throw new Error("Media record not found");
  if (!["processing", "failed"].includes(media.privacy_status)) {
    console.log(`skip media ${mediaId}: status=${media.privacy_status}`);
    return;
  }

  // 原子认领任务：重复入队的任务只有一方能把状态推进到 scanning。
  const claimed = await pool.query(
    `UPDATE media_assets SET privacy_status = 'scanning', updated_at = now()
     WHERE id = $1 AND deleted_at IS NULL AND privacy_status IN ('processing', 'failed')
     RETURNING id`,
    [mediaId]
  );
  if (!claimed.rowCount) {
    console.log(`skip media ${mediaId}: already claimed or deleted`);
    return;
  }

  const autoPublish = Boolean(config.PRIVACY_DETECTOR_URL);
  const processedKeys = processedMediaObjectKeys(mediaId);
  const publicKeys = publicMediaObjectKeys(mediaId, true);
  // 记录本次运行已写入的对象，失败时按记录补偿删除，避免部分成功残留。
  const writtenQuarantineKeys: string[] = [];
  const writtenPublicKeys: string[] = [];

  try {
    const source = await readQuarantineObject(media.quarantine_object_key);
    await scanForMalware(source);

    const scanned = await pool.query(
      `UPDATE media_assets SET privacy_status = 'processing', updated_at = now()
       WHERE id = $1 AND deleted_at IS NULL AND privacy_status = 'scanning'
       RETURNING id`,
      [mediaId]
    );
    if (!scanned.rowCount) throw new Error("Media was deleted or transitioned during processing");

    const manualRegions = media.privacy_report?.manualRegions ?? [];
    const processed = await processPrivacyImage(source, manualRegions);

    await writeQuarantineObject(processedKeys.processedKey, processed.image, "image/webp");
    writtenQuarantineKeys.push(processedKeys.processedKey);
    await writeQuarantineObject(processedKeys.thumbnailKey, processed.thumbnail, "image/webp");
    writtenQuarantineKeys.push(processedKeys.thumbnailKey);

    if (autoPublish) {
      await copyToPublic(processedKeys.processedKey, publicKeys.publicKey);
      writtenPublicKeys.push(publicKeys.publicKey);
      await copyToPublic(processedKeys.thumbnailKey, publicKeys.thumbnailKey);
      writtenPublicKeys.push(publicKeys.thumbnailKey);
    }

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

    const finalized = await pool.query(
      `UPDATE media_assets
       SET privacy_status = $2,
           processed_object_key = $3,
           thumbnail_object_key = $4,
           public_object_key = $5,
           public_thumbnail_object_key = $12,
           width = $6,
           height = $7,
           sha256 = $8,
           perceptual_hash = $9,
           privacy_report = $10::jsonb,
           failure_code = NULL,
           processed_at = now(),
           delete_after = now() + ($11::text || ' hours')::interval,
           updated_at = now()
       WHERE id = $1 AND deleted_at IS NULL AND privacy_status IN ('scanning', 'processing')
       RETURNING id`,
      [
        mediaId,
        autoPublish ? "ready" : "manual_review",
        processedKeys.processedKey,
        processedKeys.thumbnailKey,
        autoPublish ? publicKeys.publicKey : null,
        processed.width,
        processed.height,
        processed.sha256,
        processed.perceptualHash,
        JSON.stringify(report),
        String(config.ORIGINAL_RETENTION_HOURS),
        autoPublish ? publicKeys.thumbnailKey : null
      ]
    );
    if (!finalized.rowCount) throw new Error("Media was deleted or transitioned during processing");

    console.log(`media ${mediaId} processed as ${autoPublish ? "ready" : "manual_review"}`);
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "Unknown media processing error";
    try {
      await pool.query(
        `UPDATE media_assets
         SET privacy_status = 'failed', failure_code = $2,
             delete_after = now() + interval '7 days', updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL AND privacy_status IN ('scanning', 'processing')`,
        [mediaId, message]
      );
    } catch (markError) {
      console.error({ mediaId, error: markError }, "failed to mark media as failed");
    }
    // 部分成功补偿：删除本次运行已写入的隔离产物与公开对象。
    await Promise.allSettled([
      ...writtenQuarantineKeys.map((key) => deleteObject(config.S3_QUARANTINE_BUCKET, key)),
      ...writtenPublicKeys.map((key) => deleteObject(config.S3_PUBLIC_BUCKET, key))
    ]);
    throw error;
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

/**
 * 恢复卡在 publishing 的媒体（审核员确认后进程崩溃或请求中断）。
 * 与 API 的失败补偿同序：先原子回滚到 manual_review，只有回滚成功的行
 * 才删除确定性公开对象键，已定稿（ready）的媒体绝不被触碰。
 */
export async function recoverStuckPublishing(): Promise<void> {
  const result = await pool.query<{ id: string; has_thumbnail: boolean }>(
    `UPDATE media_assets
     SET privacy_status = 'manual_review',
         failure_code = 'Publish recovery after timeout',
         updated_at = now()
     WHERE privacy_status = 'publishing'
       AND updated_at < now() - interval '10 minutes'
       AND deleted_at IS NULL
     RETURNING id, (thumbnail_object_key IS NOT NULL) AS has_thumbnail`
  );

  for (const row of result.rows) {
    const keys = publicMediaObjectKeys(row.id, row.has_thumbnail);
    const removals = [deleteObject(config.S3_PUBLIC_BUCKET, keys.publicKey)];
    if (keys.thumbnailKey) removals.push(deleteObject(config.S3_PUBLIC_BUCKET, keys.thumbnailKey));
    const settled = await Promise.allSettled(removals);
    for (const outcome of settled) {
      if (outcome.status === "rejected") {
        console.error({ mediaId: row.id, error: outcome.reason }, "failed to remove stale public media object");
      }
    }
  }
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
      const removals: Array<Promise<void>> = [];
      if (!item.quarantine_object_key.startsWith("deleted/")) {
        removals.push(deleteObject(config.S3_QUARANTINE_BUCKET, item.quarantine_object_key));
      }
      if (item.processed_object_key) removals.push(deleteObject(config.S3_QUARANTINE_BUCKET, item.processed_object_key));
      if (item.thumbnail_object_key) removals.push(deleteObject(config.S3_QUARANTINE_BUCKET, item.thumbnail_object_key));
      if (item.public_object_key) removals.push(deleteObject(config.S3_PUBLIC_BUCKET, item.public_object_key));
      if (item.public_thumbnail_object_key) removals.push(deleteObject(config.S3_PUBLIC_BUCKET, item.public_thumbnail_object_key));
      // 兜底：公开对象键是确定性的，发布临界区被删除（如账号清除、随投稿删除）
      // 可能留下数据库未记录的公开对象，这里一并清理。删除不存在的键是无害空操作。
      const deterministic = publicMediaObjectKeys(item.id, Boolean(item.thumbnail_object_key));
      if (item.public_object_key !== deterministic.publicKey) {
        removals.push(deleteObject(config.S3_PUBLIC_BUCKET, deterministic.publicKey));
      }
      if (deterministic.thumbnailKey && item.public_thumbnail_object_key !== deterministic.thumbnailKey) {
        removals.push(deleteObject(config.S3_PUBLIC_BUCKET, deterministic.thumbnailKey));
      }
      await Promise.all(removals);

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
