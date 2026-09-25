/**
 * 媒体隐私处理状态机。
 *
 * 状态流转由 API 与 Worker 中带状态守卫的原子 SQL 更新执行
 * （UPDATE ... WHERE privacy_status = <源状态>），本模块是这些流转的
 * 唯一权威定义：守卫条件、恢复任务和测试都必须与此表保持一致。
 *
 * 状态含义见 docs/项目文档.md 5.3 节。
 */
export const MEDIA_STATUSES = [
  "quarantined",
  "scanning",
  "processing",
  "publishing",
  "manual_review",
  "ready",
  "rejected",
  "failed",
  "deleted"
] as const;

export type MediaStatus = (typeof MEDIA_STATUSES)[number];

export function isMediaStatus(value: unknown): value is MediaStatus {
  return typeof value === "string" && (MEDIA_STATUSES as readonly string[]).includes(value);
}

/**
 * 合法流转边：
 * - quarantined → processing：上传完成确认（POST /media/uploads/:id/complete）
 * - processing ↔ scanning：Worker 处理管线内部阶段
 * - scanning|processing → failed：扫描或处理失败
 * - processing → manual_review|ready：处理完成（无检测器需人工确认 / 自动发布）
 * - failed → scanning：失败前已入队的任务仍可能执行（自愈路径）
 * - manual_review → publishing：审核员原子认领发布，并发确认只有一方成功
 * - publishing → ready：公开派生对象复制完成并定稿
 * - publishing → manual_review：发布失败补偿或卡住恢复（公开对象已清理）
 * - failed|rejected → processing：重试
 * - 任意非终态 → deleted：删除（用户删除、账号清除、超时清理）
 */
export const MEDIA_STATUS_TRANSITIONS = {
  quarantined: ["processing", "deleted"],
  scanning: ["processing", "failed", "deleted"],
  processing: ["scanning", "manual_review", "ready", "failed", "deleted"],
  publishing: ["ready", "manual_review", "deleted"],
  manual_review: ["publishing", "rejected", "deleted"],
  ready: ["deleted"],
  rejected: ["processing", "deleted"],
  failed: ["processing", "scanning", "deleted"],
  deleted: []
} as const satisfies Record<MediaStatus, readonly MediaStatus[]>;

export class MediaStateTransitionError extends Error {
  constructor(
    public readonly from: MediaStatus,
    public readonly to: MediaStatus
  ) {
    super(`Illegal media status transition: ${from} -> ${to}`);
    this.name = "MediaStateTransitionError";
  }
}

export function canTransitionMediaStatus(from: MediaStatus, to: MediaStatus): boolean {
  return (MEDIA_STATUS_TRANSITIONS[from] as readonly MediaStatus[]).includes(to);
}

export function assertMediaStatusTransition(from: MediaStatus, to: MediaStatus): void {
  if (!canTransitionMediaStatus(from, to)) throw new MediaStateTransitionError(from, to);
}

/** 允许用户或审核员发起重试的媒体状态。 */
export const RETRYABLE_MEDIA_STATUSES = ["failed", "rejected"] as const satisfies readonly MediaStatus[];

export function canRetryMediaStatus(status: string): boolean {
  return (RETRYABLE_MEDIA_STATUSES as readonly string[]).includes(status);
}

/**
 * 允许附加到投稿的媒体状态。publishing 是秒级中间态，
 * 审核批准时媒体必须已 ready，因此投稿阶段视同 manual_review 处理。
 */
export const SUBMITTABLE_MEDIA_STATUSES = ["ready", "manual_review", "publishing"] as const satisfies readonly MediaStatus[];

export function isSubmittableMediaStatus(status: string): boolean {
  return (SUBMITTABLE_MEDIA_STATUSES as readonly string[]).includes(status);
}

export type PublicMediaObjectKeys = {
  publicKey: string;
  thumbnailKey: string | null;
};

/**
 * 公开派生对象键是确定性的：部分发布失败、进程崩溃和卡住恢复
 * 都依据该约定定位并删除已复制的公开对象。
 */
export function publicMediaObjectKeys(mediaId: string, hasThumbnail: true): { publicKey: string; thumbnailKey: string };
export function publicMediaObjectKeys(mediaId: string, hasThumbnail: boolean): PublicMediaObjectKeys;
export function publicMediaObjectKeys(mediaId: string, hasThumbnail: boolean): PublicMediaObjectKeys {
  return {
    publicKey: `media/${mediaId}.webp`,
    thumbnailKey: hasThumbnail ? `media/${mediaId}.thumb.webp` : null
  };
}

export type ProcessedMediaObjectKeys = {
  processedKey: string;
  thumbnailKey: string;
};

/** 服务端处理产物对象键（始终位于私有隔离桶）。 */
export function processedMediaObjectKeys(mediaId: string): ProcessedMediaObjectKeys {
  return {
    processedKey: `processed/${mediaId}.webp`,
    thumbnailKey: `processed/${mediaId}.thumb.webp`
  };
}
