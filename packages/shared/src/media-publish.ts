/**
 * Media object publishing state machine.
 *
 * Publishing moves processed privacy-safe objects from the private quarantine
 * bucket to the public bucket and flips the database state to `ready`. Neither
 * the object store nor the database can participate in a single transaction,
 * so the two resources are bridged with an explicit intermediate state:
 *
 *   manual_review ─┐
 *                  ├─(atomic claim)─▶ publishing ─(commit)─▶ ready
 *   processing ────┘                    │
 *                                        └─(abort + public object cleanup)─▶ failed | manual_review
 *
 * The claim is a conditional, row-locked UPDATE in the database. Only one
 * concurrent caller can win, which prevents duplicate public publishes. Every
 * object copy that succeeds is tracked individually: compensation after a
 * partial failure only removes the objects this attempt actually published,
 * so retries and competing flows never delete objects they do not own.
 */

export type MediaPublishState =
  | "quarantined"
  | "scanning"
  | "processing"
  | "manual_review"
  | "publishing"
  | "ready"
  | "rejected"
  | "failed"
  | "deleted";

export type PublishObjectSlot = "image" | "thumbnail";

export type PublishObject = {
  /** Slot inside one media aggregate; drives per-slot compensation. */
  slot: PublishObjectSlot;
  /** Key of the processed source object in the private bucket. */
  sourceKey: string;
  /** Deterministic key in the public bucket. */
  publicKey: string;
};

export type PublishPlan = {
  mediaId: string;
  /** States allowed to win the claim. */
  fromStates: readonly MediaPublishState[];
  objects: readonly PublishObject[];
};

export type PublishFailureStage = "claim" | "copy" | "commit";

export class MediaPublishError extends Error {
  constructor(
    public readonly stage: PublishFailureStage,
    message: string,
    public readonly cause?: unknown,
    public readonly state?: MediaPublishState
  ) {
    super(message);
    this.name = "MediaPublishError";
  }
}

export type PublishClaimResult =
  | { claimed: true }
  | { claimed: false; state: MediaPublishState };

export type PublishAbortResult =
  | { aborted: true }
  | { aborted: false; state: MediaPublishState };

export type PublishResult = {
  mediaId: string;
  /** Object copies this attempt performed, in execution order. */
  publishedObjects: PublishObject[];
};

/**
 * Adapter port. Implementations own SQL and S3 details; the state machine
 * only orchestrates ordering and compensation.
 */
export type MediaPublishPorts = {
  /**
   * Conditional, row-locked transition into `publishing`. Must serialise
   * concurrent callers (SELECT ... FOR UPDATE on the state column or an
   * equivalent atomic UPDATE ... WHERE status = ANY(...)).
   */
  claim: (plan: PublishPlan) => Promise<PublishClaimResult>;
  /** Copy one processed object into the public bucket. */
  copyToPublic: (object: PublishObject) => Promise<void>;
  /**
   * Conditional transition publishing -> ready and persistence of the public
   * keys. Returns false when the row is no longer claimed by this attempt
   * (e.g. it was deleted concurrently); the machine then compensates.
   */
  commit: (plan: PublishPlan, copied: readonly PublishObject[]) => Promise<boolean>;
  /**
   * Remove public objects this attempt created. Must be best-effort tolerant
   * for objects that are already absent.
   */
  removePublicObjects: (objects: readonly PublishObject[]) => Promise<void>;
  /**
   * Conditional transition publishing -> abortState with a failure code.
   * Returns false when the row is no longer in `publishing`.
   */
  markAborted: (
    plan: PublishPlan,
    abortState: "failed" | "manual_review",
    failureCode: string | null
  ) => Promise<PublishAbortResult>;
};

export type PublishOptions = {
  /**
   * State to fall back to when publishing aborts. Manual privacy confirmations
   * return to `manual_review` so a moderator can retry; automated worker
   * publishing fails the job.
   */
  abortState?: "failed" | "manual_review";
};

export const PUBLIC_PUBLISH_FAILURE_CODE = "PUBLIC_PUBLISH_FAILED";

/** Deterministic public-bucket keys; retries copy to the same target. */
export function mediaPublicKeys(mediaId: string): { image: string; thumbnail: string } {
  return {
    image: `media/${mediaId}.webp`,
    thumbnail: `media/${mediaId}.thumb.webp`
  };
}

/**
 * Run one publishing attempt. Safe to retry: copies to deterministic keys are
 * idempotent, and only the winning claimant performs them.
 */
export async function publishMediaObjects(
  ports: MediaPublishPorts,
  plan: PublishPlan,
  options: PublishOptions = {}
): Promise<PublishResult> {
  const abortState = options.abortState ?? "failed";

  const claim = await ports.claim(plan);
  if (!claim.claimed) {
    throw new MediaPublishError(
      "claim",
      `Media ${plan.mediaId} is ${claim.state}, not publishable`,
      undefined,
      claim.state
    );
  }

  const copied: PublishObject[] = [];
  try {
    for (const object of plan.objects) {
      await ports.copyToPublic(object);
      // Record success immediately so a later partial failure compensates
      // exactly the objects this attempt created — no more, no less.
      copied.push(object);
    }
  } catch (error) {
    await abortPublish(ports, plan, abortState, copied, PUBLIC_PUBLISH_FAILURE_CODE);
    throw new MediaPublishError("copy", `Public object copy failed for media ${plan.mediaId}`, error);
  }

  let committed: boolean;
  try {
    committed = await ports.commit(plan, copied);
  } catch (error) {
    await abortPublish(ports, plan, abortState, copied, PUBLIC_PUBLISH_FAILURE_CODE);
    throw new MediaPublishError("commit", `Ready commit failed for media ${plan.mediaId}`, error);
  }

  if (!committed) {
    // Lost the claim between copy and commit (e.g. concurrent hard delete).
    // Leave the database state untouched and only unwind our own copies.
    await removePublishedObjects(ports, plan, copied);
    throw new MediaPublishError("commit", `Media ${plan.mediaId} no longer holds the publishing claim`);
  }

  return { mediaId: plan.mediaId, publishedObjects: copied };
}

/**
 * Abort a held claim: first remove every public object created by this
 * attempt, then release the claim. Object cleanup runs first on purpose — if
 * it fails we keep the row in `publishing` so a maintenance reconciler retries
 * the cleanup instead of leaking privacy-unconfirmed objects in the public
 * bucket.
 */
async function abortPublish(
  ports: MediaPublishPorts,
  plan: PublishPlan,
  abortState: "failed" | "manual_review",
  copied: readonly PublishObject[],
  failureCode: string | null
): Promise<void> {
  await removePublishedObjects(ports, plan, copied);
  await ports.markAborted(plan, abortState, failureCode);
}

async function removePublishedObjects(
  ports: MediaPublishPorts,
  plan: PublishPlan,
  objects: readonly PublishObject[]
): Promise<void> {
  if (!objects.length) return;
  try {
    await ports.removePublicObjects(objects);
  } catch (error) {
    throw new MediaPublishError(
      "copy",
      `Public object compensation failed for media ${plan.mediaId}; row stays in publishing for reconciliation`,
      error
    );
  }
}
