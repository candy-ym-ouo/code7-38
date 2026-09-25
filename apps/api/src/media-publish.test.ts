import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaPublishDeps } from "./media-publish";
import { AppError } from "./errors";

let approveMediaPrivacy: typeof import("./media-publish").approveMediaPrivacy;
let compensateFailedPublish: typeof import("./media-publish").compensateFailedPublish;
let CLAIM_MEDIA_FOR_PUBLISH_SQL: typeof import("./media-publish").CLAIM_MEDIA_FOR_PUBLISH_SQL;
let FINALIZE_MEDIA_PUBLISH_SQL: typeof import("./media-publish").FINALIZE_MEDIA_PUBLISH_SQL;
let REVERT_MEDIA_PUBLISH_SQL: typeof import("./media-publish").REVERT_MEDIA_PUBLISH_SQL;

const MEDIA_ID = "7b8f9d10-1c2d-4e5f-9a8b-7c6d5e4f3a2b";
const ACTOR_ID = "1a2b3c4d-5e6f-4a5b-8c9d-0e1f2a3b4c5d";

beforeAll(async () => {
  process.env.DATABASE_URL = "postgres://map:map@localhost:5432/map";
  process.env.S3_ENDPOINT = "http://localhost:9000";
  process.env.S3_PUBLIC_ENDPOINT = "http://localhost:9000";
  process.env.S3_ACCESS_KEY = "test";
  process.env.S3_SECRET_KEY = "test";
  process.env.S3_QUARANTINE_BUCKET = "quarantine";
  process.env.S3_PUBLIC_BUCKET = "public";
  process.env.PUBLIC_MEDIA_BASE_URL = "http://localhost:9000/public";
  process.env.JWT_ACCESS_SECRET = "test-secret-that-is-long-enough-32";
  const module = await import("./media-publish");
  approveMediaPrivacy = module.approveMediaPrivacy;
  compensateFailedPublish = module.compensateFailedPublish;
  CLAIM_MEDIA_FOR_PUBLISH_SQL = module.CLAIM_MEDIA_FOR_PUBLISH_SQL;
  FINALIZE_MEDIA_PUBLISH_SQL = module.FINALIZE_MEDIA_PUBLISH_SQL;
  REVERT_MEDIA_PUBLISH_SQL = module.REVERT_MEDIA_PUBLISH_SQL;
});

type DepOverrides = Partial<MediaPublishDeps>;

function createDeps(overrides: DepOverrides = {}) {
  const calls = {
    claim: [] as string[],
    publish: [] as Array<[string, string]>,
    finalize: [] as string[],
    revert: [] as string[],
    remove: [] as string[]
  };
  const behavior: MediaPublishDeps = {
    async claim(mediaId) {
      return { id: mediaId, processedObjectKey: `processed/${mediaId}.webp`, thumbnailObjectKey: `processed/${mediaId}.thumb.webp` };
    },
    async publish() {},
    async finalize() { return true; },
    async revert() { return true; },
    async remove() {},
    ...overrides
  };
  const deps: MediaPublishDeps = {
    async claim(mediaId) {
      calls.claim.push(mediaId);
      return behavior.claim(mediaId);
    },
    async publish(sourceKey, publicKey) {
      calls.publish.push([sourceKey, publicKey]);
      return behavior.publish(sourceKey, publicKey);
    },
    async finalize(mediaId, keys, actorId) {
      calls.finalize.push(mediaId);
      return behavior.finalize(mediaId, keys, actorId);
    },
    async revert(mediaId, failureCode) {
      calls.revert.push(mediaId);
      return behavior.revert(mediaId, failureCode);
    },
    async remove(publicKey) {
      calls.remove.push(publicKey);
      return behavior.remove(publicKey);
    }
  };
  return { deps, calls };
}

describe("approveMediaPrivacy", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("claims, publishes both derivatives and finalizes on the happy path", async () => {
    const { deps, calls } = createDeps();
    const keys = await approveMediaPrivacy(deps, { mediaId: MEDIA_ID, actorId: ACTOR_ID });

    expect(keys).toEqual({ publicKey: `media/${MEDIA_ID}.webp`, thumbnailKey: `media/${MEDIA_ID}.thumb.webp` });
    expect(calls.claim).toEqual([MEDIA_ID]);
    expect(calls.publish).toEqual([
      [`processed/${MEDIA_ID}.webp`, `media/${MEDIA_ID}.webp`],
      [`processed/${MEDIA_ID}.thumb.webp`, `media/${MEDIA_ID}.thumb.webp`]
    ]);
    expect(calls.finalize).toEqual([MEDIA_ID]);
    expect(calls.revert).toEqual([]);
    expect(calls.remove).toEqual([]);
  });

  it("publishes only the main object when no thumbnail exists", async () => {
    const { deps, calls } = createDeps({
      async claim(mediaId) {
        return { id: mediaId, processedObjectKey: `processed/${mediaId}.webp`, thumbnailObjectKey: null };
      }
    });
    const keys = await approveMediaPrivacy(deps, { mediaId: MEDIA_ID, actorId: ACTOR_ID });

    expect(keys.thumbnailKey).toBeNull();
    expect(calls.publish).toEqual([[`processed/${MEDIA_ID}.webp`, `media/${MEDIA_ID}.webp`]]);
    expect(calls.remove).toEqual([]);
  });

  it("rejects with 409 when a concurrent confirmation already claimed the media", async () => {
    const { deps, calls } = createDeps({ async claim() { return null; } });

    const error = await approveMediaPrivacy(deps, { mediaId: MEDIA_ID, actorId: ACTOR_ID }).catch((cause) => cause);
    expect(error).toBeInstanceOf(AppError);
    expect(error.statusCode).toBe(409);
    expect(error.code).toBe("CONFLICT");
    // 认领失败时绝不能复制公开对象。
    expect(calls.publish).toEqual([]);
    expect(calls.remove).toEqual([]);
  });

  it("compensates partial success: thumbnail publish failure removes both public keys and reverts", async () => {
    const { deps, calls } = createDeps({
      async publish(_sourceKey, publicKey) {
        if (publicKey.endsWith(".thumb.webp")) throw new Error("S3 copy failed");
      }
    });

    await expect(approveMediaPrivacy(deps, { mediaId: MEDIA_ID, actorId: ACTOR_ID })).rejects.toThrow("S3 copy failed");
    expect(calls.revert).toEqual([MEDIA_ID]);
    expect(calls.remove).toEqual([`media/${MEDIA_ID}.webp`, `media/${MEDIA_ID}.thumb.webp`]);
    expect(calls.finalize).toEqual([]);
  });

  it("removes published objects when finalization fails after a successful copy", async () => {
    const { deps, calls } = createDeps({
      async finalize() { throw new Error("database unavailable"); }
    });

    await expect(approveMediaPrivacy(deps, { mediaId: MEDIA_ID, actorId: ACTOR_ID })).rejects.toThrow("database unavailable");
    expect(calls.revert).toEqual([MEDIA_ID]);
    expect(calls.remove).toEqual([`media/${MEDIA_ID}.webp`, `media/${MEDIA_ID}.thumb.webp`]);
  });

  it("keeps public objects when the revert reports the row already moved on", async () => {
    // 定稿实际已提交（如提交响应丢失）：回滚守卫不匹配，公开对象必须保留。
    const { deps, calls } = createDeps({
      async finalize() { throw new Error("commit response lost"); },
      async revert() { return false; }
    });

    await expect(approveMediaPrivacy(deps, { mediaId: MEDIA_ID, actorId: ACTOR_ID })).rejects.toThrow("commit response lost");
    expect(calls.revert).toEqual([MEDIA_ID]);
    expect(calls.remove).toEqual([]);
  });

  it("leaves objects for the recovery job when the revert itself fails", async () => {
    const { deps, calls } = createDeps({
      async finalize() { throw new Error("publish failed"); },
      async revert() { throw new Error("database unavailable"); }
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(approveMediaPrivacy(deps, { mediaId: MEDIA_ID, actorId: ACTOR_ID })).rejects.toThrow("publish failed");
    expect(calls.remove).toEqual([]);
    expect(consoleError).toHaveBeenCalled();
  });

  it("rejects when finalization reports the row is no longer publishing", async () => {
    // 行已被移动（如随账号清除）：定稿与回滚的状态守卫都不会匹配。
    const { deps, calls } = createDeps({
      async finalize() { return false; },
      async revert() { return false; }
    });

    const error = await approveMediaPrivacy(deps, { mediaId: MEDIA_ID, actorId: ACTOR_ID }).catch((cause) => cause);
    expect(error).toBeInstanceOf(AppError);
    expect(error.statusCode).toBe(409);
    // 行已不在 publishing（可能已被删除或移动），补偿不得删除公开对象。
    expect(calls.remove).toEqual([]);
  });
});

describe("compensateFailedPublish", () => {
  it("reverts first and only deletes objects after a successful revert", async () => {
    const order: string[] = [];
    const deps = {
      async revert() {
        order.push("revert");
        return true;
      },
      async remove(key: string) {
        order.push(`remove:${key}`);
      }
    };
    await compensateFailedPublish(deps, MEDIA_ID, { publicKey: "media/a.webp", thumbnailKey: null }, new Error("boom"));
    expect(order).toEqual(["revert", "remove:media/a.webp"]);
  });
});

describe("publish state machine SQL guards", () => {
  it("claims only manual_review rows and moves them to publishing", () => {
    expect(CLAIM_MEDIA_FOR_PUBLISH_SQL).toContain("privacy_status = 'manual_review'");
    expect(CLAIM_MEDIA_FOR_PUBLISH_SQL).toContain("SET privacy_status = 'publishing'");
    expect(CLAIM_MEDIA_FOR_PUBLISH_SQL).toContain("deleted_at IS NULL");
  });

  it("finalizes and reverts only rows still in publishing", () => {
    expect(FINALIZE_MEDIA_PUBLISH_SQL).toContain("privacy_status = 'publishing'");
    expect(FINALIZE_MEDIA_PUBLISH_SQL).toContain("SET privacy_status = 'ready'");
    expect(REVERT_MEDIA_PUBLISH_SQL).toContain("privacy_status = 'publishing'");
    expect(REVERT_MEDIA_PUBLISH_SQL).toContain("SET privacy_status = 'manual_review'");
  });
});
