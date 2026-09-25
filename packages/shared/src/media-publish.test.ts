import { describe, expect, it, vi } from "vitest";
import {
  MediaPublishError,
  PUBLIC_PUBLISH_FAILURE_CODE,
  mediaPublicKeys,
  publishMediaObjects,
  type MediaPublishPorts,
  type PublishObject,
  type PublishPlan
} from "./media-publish";

const keys = mediaPublicKeys("11111111-1111-1111-1111-111111111111");

const plan: PublishPlan = {
  mediaId: "11111111-1111-1111-1111-111111111111",
  fromStates: ["manual_review"],
  objects: [
    { slot: "image", sourceKey: "processed/11111111.webp", publicKey: keys.image },
    { slot: "thumbnail", sourceKey: "processed/11111111.thumb.webp", publicKey: keys.thumbnail }
  ]
};

function makePorts(overrides: Partial<MediaPublishPorts> = {}): MediaPublishPorts & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    claim: vi.fn(async () => {
      calls.push("claim");
      return { claimed: true } as const;
    }),
    copyToPublic: vi.fn(async (object: PublishObject) => {
      calls.push(`copy:${object.slot}`);
    }),
    commit: vi.fn(async () => {
      calls.push("commit");
      return true;
    }),
    removePublicObjects: vi.fn(async (objects: readonly PublishObject[]) => {
      calls.push(`remove:${objects.map((object) => object.slot).join("+")}`);
    }),
    markAborted: vi.fn(async () => {
      calls.push("markAborted");
      return { aborted: true } as const;
    }),
    ...overrides
  };
}

describe("publishMediaObjects", () => {
  it("publishes every object and commits after the winning claim", async () => {
    const ports = makePorts();
    const result = await publishMediaObjects(ports, plan);

    expect(ports.calls).toEqual(["claim", "copy:image", "copy:thumbnail", "commit"]);
    expect(result.publishedObjects.map((object) => object.slot)).toEqual(["image", "thumbnail"]);
    expect(ports.removePublicObjects).not.toHaveBeenCalled();
  });

  it("rejects a concurrent confirmation that loses the claim without copying", async () => {
    const ports = makePorts({
      claim: vi.fn(async () => ({ claimed: false, state: "publishing" }) as const)
    });

    await expect(publishMediaObjects(ports, plan)).rejects.toMatchObject({
      name: "MediaPublishError",
      stage: "claim",
      state: "publishing"
    });
    expect(ports.copyToPublic).not.toHaveBeenCalled();
    expect(ports.commit).not.toHaveBeenCalled();
    expect(ports.removePublicObjects).not.toHaveBeenCalled();
  });

  it("compensates only the objects that were copied on partial success", async () => {
    const ports = makePorts({
      copyToPublic: vi.fn(async (object: PublishObject) => {
        if (object.slot === "thumbnail") throw new Error("thumbnail copy failed");
      })
    });

    await expect(publishMediaObjects(ports, plan, { abortState: "manual_review" })).rejects.toMatchObject({
      name: "MediaPublishError",
      stage: "copy"
    });

    // Only the image existed; the thumbnail copy never succeeded.
    expect(ports.removePublicObjects).toHaveBeenCalledTimes(1);
    const removed = vi.mocked(ports.removePublicObjects).mock.calls[0]![0];
    expect(removed.map((object) => object.slot)).toEqual(["image"]);
    expect(ports.markAborted).toHaveBeenCalledWith(plan, "manual_review", PUBLIC_PUBLISH_FAILURE_CODE);
    expect(ports.commit).not.toHaveBeenCalled();
  });

  it("does not mark aborted when compensation deletion fails, leaving the row for reconciliation", async () => {
    const ports = makePorts({
      copyToPublic: vi.fn(async (object: PublishObject) => {
        if (object.slot === "thumbnail") throw new Error("public bucket unavailable");
      }),
      removePublicObjects: vi.fn(async () => {
        throw new Error("delete also failed");
      })
    });

    await expect(publishMediaObjects(ports, plan)).rejects.toMatchObject({ stage: "copy" });
    // The image copy succeeded but its compensation delete failed: the row
    // must stay in `publishing` so the reconciler retries the delete instead
    // of leaking the object in the public bucket.
    expect(ports.removePublicObjects).toHaveBeenCalledTimes(1);
    expect(ports.markAborted).not.toHaveBeenCalled();
  });

  it("unwinds copies without changing state when the commit loses the claim", async () => {
    const ports = makePorts({
      commit: vi.fn(async () => false)
    });

    await expect(publishMediaObjects(ports, plan)).rejects.toBeInstanceOf(MediaPublishError);
    const removed = vi.mocked(ports.removePublicObjects).mock.calls[0]![0];
    expect(removed.map((object) => object.slot)).toEqual(["image", "thumbnail"]);
    expect(ports.markAborted).not.toHaveBeenCalled();
  });

  it("aborts with failure code when the commit query throws", async () => {
    const ports = makePorts({
      commit: vi.fn(async () => {
        throw new Error("database unavailable");
      })
    });

    await expect(publishMediaObjects(ports, plan)).rejects.toMatchObject({ stage: "commit" });
    const removed = vi.mocked(ports.removePublicObjects).mock.calls[0]![0];
    expect(removed.map((object) => object.slot)).toEqual(["image", "thumbnail"]);
    expect(ports.markAborted).toHaveBeenCalledWith(plan, "failed", PUBLIC_PUBLISH_FAILURE_CODE);
  });

  it("supports retrying to the deterministic keys after a failed attempt", async () => {
    const retryPlan: PublishPlan = { ...plan, fromStates: ["failed", "manual_review"] };

    // First attempt: thumbnail copy fails after the image was published.
    const firstPorts = makePorts({
      copyToPublic: vi.fn(async (object: PublishObject) => {
        if (object.slot === "thumbnail") throw new Error("transient");
      })
    });
    await expect(publishMediaObjects(firstPorts, retryPlan)).rejects.toMatchObject({ stage: "copy" });

    // Retry after the transient error clears: the claim accepts `failed`,
    // copies target the same deterministic public keys and then commit.
    const secondPorts = makePorts();
    const result = await publishMediaObjects(secondPorts, retryPlan);

    expect(secondPorts.calls).toEqual(["claim", "copy:image", "copy:thumbnail", "commit"]);
    expect(vi.mocked(secondPorts.claim).mock.calls[0]![0]).toEqual(retryPlan);
    expect(result.publishedObjects.map((object) => object.publicKey)).toEqual([
      keys.image,
      keys.thumbnail
    ]);
  });
});
