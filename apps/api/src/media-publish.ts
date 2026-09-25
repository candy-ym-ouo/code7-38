import { publicMediaObjectKeys, type PublicMediaObjectKeys } from "@map/shared/media-state";
import { config } from "./config";
import { query, transaction } from "./db";
import { conflict } from "./errors";
import { deleteObject, publishMediaObject } from "./storage";
import { recordAudit } from "./audit";

/**
 * 媒体隐私确认发布编排。
 *
 * 状态机：manual_review --原子认领--> publishing --定稿--> ready
 *                            ^________失败补偿 / 卡住恢复________|
 *
 * 认领、定稿、回滚都是带状态守卫的原子 UPDATE：并发确认只有一方能认领成功，
 * 另一方收到 409。公开对象键是确定性的，任何失败路径都按“先回滚状态、
 * 确认回滚成功后再删除公开对象”的顺序补偿，绝不会误删已定稿的公开对象。
 */

export type ClaimedMedia = {
  id: string;
  processedObjectKey: string;
  thumbnailObjectKey: string | null;
};

export type MediaPublishDeps = {
  /** 原子认领：manual_review -> publishing。返回 null 表示已被他人认领或状态已变化。 */
  claim(mediaId: string): Promise<ClaimedMedia | null>;
  /** 把处理产物复制到公开桶。 */
  publish(sourceKey: string, publicKey: string): Promise<void>;
  /** 定稿：publishing -> ready，写入公开键与审计。返回 false 表示行已不在 publishing。 */
  finalize(mediaId: string, keys: PublicMediaObjectKeys, actorId: string): Promise<boolean>;
  /** 回滚：publishing -> manual_review。返回 false 表示定稿已提交或状态已被移动。 */
  revert(mediaId: string, failureCode: string): Promise<boolean>;
  /** 删除公开桶对象（补偿）。 */
  remove(publicKey: string): Promise<void>;
};

export const CLAIM_MEDIA_FOR_PUBLISH_SQL = `
  UPDATE media_assets
  SET privacy_status = 'publishing', failure_code = NULL, updated_at = now()
  WHERE id = $1 AND deleted_at IS NULL
    AND privacy_status = 'manual_review'
    AND processed_object_key IS NOT NULL
  RETURNING id, processed_object_key, thumbnail_object_key
`;

export const FINALIZE_MEDIA_PUBLISH_SQL = `
  UPDATE media_assets
  SET privacy_status = 'ready',
      public_object_key = $2,
      public_thumbnail_object_key = $3,
      processed_at = now(),
      updated_at = now()
  WHERE id = $1 AND privacy_status = 'publishing'
`;

export const REVERT_MEDIA_PUBLISH_SQL = `
  UPDATE media_assets
  SET privacy_status = 'manual_review', failure_code = $2, updated_at = now()
  WHERE id = $1 AND privacy_status = 'publishing'
`;

function failureCodeFrom(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown publish error";
  return `PUBLISH_FAILED: ${message}`.slice(0, 500);
}

/**
 * 失败补偿：先回滚状态，只有回滚成功（即定稿确实没有提交）才删除公开对象。
 * 回滚返回 false 说明定稿已提交或状态已被移动，公开对象可能已在服役，必须保留；
 * 回滚本身失败（如数据库不可用）时保留现场，由 Worker 的卡住恢复任务按同一顺序补偿。
 */
export async function compensateFailedPublish(
  deps: Pick<MediaPublishDeps, "revert" | "remove">,
  mediaId: string,
  keys: PublicMediaObjectKeys,
  cause: unknown
): Promise<void> {
  let reverted = false;
  try {
    reverted = await deps.revert(mediaId, failureCodeFrom(cause));
  } catch (revertError) {
    console.error({ mediaId, error: revertError }, "failed to revert media publish claim; leaving for recovery");
    return;
  }
  if (!reverted) return;
  const keysToRemove = [keys.publicKey, keys.thumbnailKey].filter((key): key is string => Boolean(key));
  await Promise.allSettled(keysToRemove.map((key) => deps.remove(key)));
}

export async function approveMediaPrivacy(
  deps: MediaPublishDeps,
  input: { mediaId: string; actorId: string }
): Promise<PublicMediaObjectKeys> {
  const claim = await deps.claim(input.mediaId);
  if (!claim) throw conflict("Media is not waiting for manual privacy approval");

  const keys = publicMediaObjectKeys(input.mediaId, Boolean(claim.thumbnailObjectKey));
  try {
    await deps.publish(claim.processedObjectKey, keys.publicKey);
    if (claim.thumbnailObjectKey && keys.thumbnailKey) {
      await deps.publish(claim.thumbnailObjectKey, keys.thumbnailKey);
    }
    const finalized = await deps.finalize(input.mediaId, keys, input.actorId);
    if (!finalized) throw conflict("Media publish state changed during approval");
    return keys;
  } catch (error) {
    await compensateFailedPublish(deps, input.mediaId, keys, error);
    throw error;
  }
}

/** 生产依赖：Postgres 状态守卫 + S3 公开桶。 */
export const mediaPublishDeps: MediaPublishDeps = {
  async claim(mediaId) {
    const result = await query<{ id: string; processed_object_key: string; thumbnail_object_key: string | null }>(
      CLAIM_MEDIA_FOR_PUBLISH_SQL,
      [mediaId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return { id: row.id, processedObjectKey: row.processed_object_key, thumbnailObjectKey: row.thumbnail_object_key };
  },
  async publish(sourceKey, publicKey) {
    await publishMediaObject(sourceKey, publicKey);
  },
  async finalize(mediaId, keys, actorId) {
    return transaction(async (client) => {
      const result = await client.query(FINALIZE_MEDIA_PUBLISH_SQL, [mediaId, keys.publicKey, keys.thumbnailKey]);
      if (!result.rowCount) return false;
      await recordAudit(client, {
        actorId,
        action: "media.privacy_approved",
        resourceType: "media",
        resourceId: mediaId
      });
      return true;
    });
  },
  async revert(mediaId, failureCode) {
    const result = await query(REVERT_MEDIA_PUBLISH_SQL, [mediaId, failureCode]);
    return Boolean(result.rowCount);
  },
  async remove(publicKey) {
    await deleteObject(config.S3_PUBLIC_BUCKET, publicKey);
  }
};
