import {
  mediaPublicKeys,
  type MediaPublishPorts,
  type MediaPublishState,
  type PublishObject,
  type PublishPlan
} from "@map/shared/media-publish";
import { pool, transaction } from "./db";
import { deleteObject, publishMediaObject } from "./storage";
import { config } from "./config";
import { recordAudit } from "./audit";

/**
 * API-side ports for the media publishing state machine.
 *
 * The claim is a row-locked conditional transition so two moderators
 * confirming the same media concurrently cannot both copy public objects.
 * Manual confirmations return to `manual_review` on abort, which keeps the
 * item in the moderation queue for a retry instead of failing it.
 */
export function buildManualReviewPorts(
  mediaId: string,
  moderatorId: string
): MediaPublishPorts {
  return {
    async claim(plan: PublishPlan) {
      return transaction(async (client) => {
        const result = await client.query<{ privacy_status: string }>(
          `SELECT privacy_status FROM media_assets
           WHERE id = $1 AND deleted_at IS NULL
           FOR UPDATE`,
          [mediaId]
        );
        const row = result.rows[0];
        if (!row) return { claimed: false as const, state: "deleted" as MediaPublishState };
        if (!(plan.fromStates as readonly string[]).includes(row.privacy_status)) {
          return { claimed: false as const, state: row.privacy_status as MediaPublishState };
        }
        await client.query(
          `UPDATE media_assets
           SET privacy_status = 'publishing', failure_code = NULL, updated_at = now()
           WHERE id = $1`,
          [mediaId]
        );
        await recordAudit(client, {
          actorId: moderatorId,
          action: "media.privacy_publish_claimed",
          resourceType: "media",
          resourceId: mediaId
        });
        return { claimed: true as const };
      });
    },

    copyToPublic: (object) => publishMediaObject(object.sourceKey, object.publicKey),

    async commit(plan) {
      return transaction(async (client) => {
        const result = await client.query(
          `UPDATE media_assets
           SET privacy_status = 'ready',
               public_object_key = $2,
               public_thumbnail_object_key = $3,
               failure_code = NULL,
               processed_at = now(),
               updated_at = now()
           WHERE id = $1 AND privacy_status = 'publishing' AND deleted_at IS NULL`,
          [
            mediaId,
            plan.objects.find((object) => object.slot === "image")?.publicKey ?? null,
            plan.objects.find((object) => object.slot === "thumbnail")?.publicKey ?? null
          ]
        );
        if (!result.rowCount) return false;
        await recordAudit(client, {
          actorId: moderatorId,
          action: "media.privacy_approved",
          resourceType: "media",
          resourceId: mediaId
        });
        return true;
      });
    },

    async removePublicObjects(objects) {
      await Promise.all(
        objects.map((object) => deleteObject(config.S3_PUBLIC_BUCKET, object.publicKey))
      );
    },

    async markAborted(_plan, abortState) {
      const result = await pool.query(
        `UPDATE media_assets
         SET privacy_status = $2,
             failure_code = CASE WHEN $2 = 'failed' THEN 'PUBLIC_PUBLISH_FAILED' ELSE NULL END,
             updated_at = now()
         WHERE id = $1 AND privacy_status = 'publishing' AND deleted_at IS NULL
         RETURNING privacy_status`,
        [mediaId, abortState]
      );
      if (!result.rowCount) {
        const current = await pool.query<{ privacy_status: string }>(
          "SELECT privacy_status FROM media_assets WHERE id = $1",
          [mediaId]
        );
        return {
          aborted: false,
          state: (current.rows[0]?.privacy_status ?? "deleted") as MediaPublishState
        };
      }
      return { aborted: true };
    }
  };
}

export function buildManualReviewPlan(
  mediaId: string,
  processedObjectKey: string,
  thumbnailObjectKey: string | null
): PublishPlan {
  const keys = mediaPublicKeys(mediaId);
  const objects: PublishObject[] = [
    { slot: "image", sourceKey: processedObjectKey, publicKey: keys.image }
  ];
  if (thumbnailObjectKey) {
    objects.push({ slot: "thumbnail", sourceKey: thumbnailObjectKey, publicKey: keys.thumbnail });
  }
  return { mediaId, fromStates: ["manual_review"], objects };
}
