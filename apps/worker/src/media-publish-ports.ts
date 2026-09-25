import {
  type MediaPublishPorts,
  type MediaPublishState,
  type PublishPlan
} from "@map/shared/media-publish";
import { config } from "./config";
import { pool } from "./db";
import { copyToPublic, deleteObject } from "./storage";

/**
 * Worker-side ports for the media publishing state machine (automatic
 * publishing when a privacy detector is configured). The claim is a single
 * conditional UPDATE so duplicate queue jobs cannot publish twice.
 */
export function buildWorkerPublishPorts(mediaId: string): MediaPublishPorts {
  return {
    async claim(plan: PublishPlan) {
      const result = await pool.query(
        `UPDATE media_assets
         SET privacy_status = 'publishing', updated_at = now()
         WHERE id = $1 AND privacy_status = ANY($2::media_status[]) AND deleted_at IS NULL
         RETURNING id`,
        [mediaId, [...plan.fromStates]]
      );
      if (result.rowCount) return { claimed: true as const };
      const current = await pool.query<{ privacy_status: string }>(
        "SELECT privacy_status FROM media_assets WHERE id = $1 AND deleted_at IS NULL",
        [mediaId]
      );
      return {
        claimed: false as const,
        state: (current.rows[0]?.privacy_status ?? "deleted") as MediaPublishState
      };
    },

    copyToPublic: (object) => copyToPublic(object.sourceKey, object.publicKey),

    async commit(plan) {
      const result = await pool.query(
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
      return Boolean(result.rowCount);
    },

    async removePublicObjects(objects) {
      await Promise.all(
        objects.map((object) => deleteObject(config.S3_PUBLIC_BUCKET, object.publicKey))
      );
    },

    async markAborted(_plan, abortState) {
      const result = await pool.query(
        `UPDATE media_assets
         SET privacy_status = $2::media_status,
             failure_code = 'PUBLIC_PUBLISH_FAILED',
             delete_after = now() + interval '7 days',
             updated_at = now()
         WHERE id = $1 AND privacy_status = 'publishing' AND deleted_at IS NULL
         RETURNING id`,
        [mediaId, abortState]
      );
      if (!result.rowCount) {
        const current = await pool.query<{ privacy_status: string }>(
          "SELECT privacy_status FROM media_assets WHERE id = $1 AND deleted_at IS NULL",
          [mediaId]
        );
        return {
          aborted: false as const,
          state: (current.rows[0]?.privacy_status ?? "deleted") as MediaPublishState
        };
      }
      return { aborted: true as const };
    }
  };
}
