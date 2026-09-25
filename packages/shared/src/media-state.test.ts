import { describe, expect, it } from "vitest";
import {
  MEDIA_STATUSES,
  MEDIA_STATUS_TRANSITIONS,
  MediaStateTransitionError,
  assertMediaStatusTransition,
  canRetryMediaStatus,
  canTransitionMediaStatus,
  isMediaStatus,
  isSubmittableMediaStatus,
  processedMediaObjectKeys,
  publicMediaObjectKeys
} from "./media-state";

describe("media status state machine", () => {
  it("defines a transition entry for every status", () => {
    for (const status of MEDIA_STATUSES) {
      expect(MEDIA_STATUS_TRANSITIONS).toHaveProperty(status);
      expect(Array.isArray(MEDIA_STATUS_TRANSITIONS[status])).toBe(true);
    }
    expect(isMediaStatus("publishing")).toBe(true);
    expect(isMediaStatus("bogus")).toBe(false);
  });

  it("routes manual approval through the atomic publishing claim", () => {
    expect(canTransitionMediaStatus("manual_review", "publishing")).toBe(true);
    expect(canTransitionMediaStatus("publishing", "ready")).toBe(true);
    // 不允许跳过认领直接发布，否则并发确认会重复复制公开对象。
    expect(canTransitionMediaStatus("manual_review", "ready")).toBe(false);
  });

  it("allows publish failure compensation and stuck recovery back to manual_review", () => {
    expect(canTransitionMediaStatus("publishing", "manual_review")).toBe(true);
  });

  it("allows the worker pipeline and retry edges", () => {
    expect(canTransitionMediaStatus("quarantined", "processing")).toBe(true);
    expect(canTransitionMediaStatus("processing", "scanning")).toBe(true);
    expect(canTransitionMediaStatus("scanning", "processing")).toBe(true);
    expect(canTransitionMediaStatus("processing", "manual_review")).toBe(true);
    expect(canTransitionMediaStatus("processing", "ready")).toBe(true);
    expect(canTransitionMediaStatus("processing", "failed")).toBe(true);
    expect(canTransitionMediaStatus("scanning", "failed")).toBe(true);
    expect(canTransitionMediaStatus("failed", "processing")).toBe(true);
    expect(canTransitionMediaStatus("rejected", "processing")).toBe(true);
    // 失败前已入队的任务仍可能拿到行并继续处理。
    expect(canTransitionMediaStatus("failed", "scanning")).toBe(true);
  });

  it("forbids skipping the pipeline", () => {
    expect(canTransitionMediaStatus("quarantined", "ready")).toBe(false);
    expect(canTransitionMediaStatus("ready", "processing")).toBe(false);
    expect(canTransitionMediaStatus("manual_review", "scanning")).toBe(false);
  });

  it("treats deleted as terminal and reachable from every non-terminal status", () => {
    expect(MEDIA_STATUS_TRANSITIONS.deleted).toEqual([]);
    for (const status of MEDIA_STATUSES) {
      if (status === "deleted") continue;
      expect(canTransitionMediaStatus(status, "deleted")).toBe(true);
    }
    expect(canTransitionMediaStatus("deleted", "processing")).toBe(false);
  });

  it("throws a descriptive error for illegal transitions", () => {
    expect(() => assertMediaStatusTransition("ready", "failed")).toThrow(MediaStateTransitionError);
    expect(() => assertMediaStatusTransition("manual_review", "publishing")).not.toThrow();
  });

  it("limits retries to failed and rejected media", () => {
    expect(canRetryMediaStatus("failed")).toBe(true);
    expect(canRetryMediaStatus("rejected")).toBe(true);
    for (const status of MEDIA_STATUSES) {
      if (status === "failed" || status === "rejected") continue;
      expect(canRetryMediaStatus(status)).toBe(false);
    }
  });

  it("accepts ready, manual review and in-flight publishing media for submission", () => {
    expect(isSubmittableMediaStatus("ready")).toBe(true);
    expect(isSubmittableMediaStatus("manual_review")).toBe(true);
    expect(isSubmittableMediaStatus("publishing")).toBe(true);
    expect(isSubmittableMediaStatus("processing")).toBe(false);
    expect(isSubmittableMediaStatus("failed")).toBe(false);
  });
});

describe("deterministic media object keys", () => {
  it("derives public keys from the media id", () => {
    expect(publicMediaObjectKeys("abc", true)).toEqual({
      publicKey: "media/abc.webp",
      thumbnailKey: "media/abc.thumb.webp"
    });
    expect(publicMediaObjectKeys("abc", false)).toEqual({
      publicKey: "media/abc.webp",
      thumbnailKey: null
    });
  });

  it("derives quarantine processed keys from the media id", () => {
    expect(processedMediaObjectKeys("abc")).toEqual({
      processedKey: "processed/abc.webp",
      thumbnailKey: "processed/abc.thumb.webp"
    });
  });
});
