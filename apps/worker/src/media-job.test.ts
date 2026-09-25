import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn<(sql: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>>();
const readQuarantineObjectMock = vi.fn<(key: string) => Promise<Buffer>>();
const writeQuarantineObjectMock = vi.fn<(key: string, body: Buffer, contentType: string) => Promise<void>>();
const copyToPublicMock = vi.fn<(processedKey: string, publicKey: string) => Promise<void>>();
const deleteObjectMock = vi.fn<(bucket: string, key: string) => Promise<void>>();
const objectExistsMock = vi.fn<(bucket: string, key: string) => Promise<boolean>>();
const scanForMalwareMock = vi.fn<(source: Buffer) => Promise<void>>();
const processPrivacyImageMock = vi.fn<(source: Buffer, regions: unknown[]) => Promise<unknown>>();

vi.mock("./db", () => ({
  pool: { query: (sql: string, values?: unknown[]) => queryMock(sql, values) }
}));
vi.mock("./storage", () => ({
  readQuarantineObject: (key: string) => readQuarantineObjectMock(key),
  writeQuarantineObject: (key: string, body: Buffer, contentType: string) => writeQuarantineObjectMock(key, body, contentType),
  copyToPublic: (processedKey: string, publicKey: string) => copyToPublicMock(processedKey, publicKey),
  deleteObject: (bucket: string, key: string) => deleteObjectMock(bucket, key),
  objectExists: (bucket: string, key: string) => objectExistsMock(bucket, key)
}));
vi.mock("./clamav", () => ({
  scanForMalware: (source: Buffer) => scanForMalwareMock(source)
}));
vi.mock("./privacy", () => ({
  processPrivacyImage: (source: Buffer, regions: unknown[]) => processPrivacyImageMock(source, regions)
}));

const BASE_ENV: Record<string, string> = {
  DATABASE_URL: "postgres://map:map@localhost:5432/map",
  S3_ENDPOINT: "http://localhost:9000",
  S3_PUBLIC_ENDPOINT: "http://localhost:9000",
  S3_ACCESS_KEY: "test",
  S3_SECRET_KEY: "test",
  S3_QUARANTINE_BUCKET: "quarantine-bucket",
  S3_PUBLIC_BUCKET: "public-bucket",
  PRIVACY_DETECTOR_URL: "",
  CLAMAV_ENABLED: "false"
};

const MEDIA_ID = "7b8f9d10-1c2d-4e5f-9a8b-7c6d5e4f3a2b";

async function loadJob(env: Record<string, string> = {}) {
  Object.assign(process.env, BASE_ENV, env);
  vi.resetModules();
  return import("./media-job");
}

function mockProcessingRow() {
  queryMock.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM media_assets WHERE id = $1")) {
      return {
        rows: [{
          id: MEDIA_ID,
          privacy_status: "processing",
          quarantine_object_key: `quarantine/owner/${MEDIA_ID}.jpg`,
          privacy_report: { manualRegions: [] }
        }],
        rowCount: 1
      };
    }
    return { rows: [{ id: MEDIA_ID }], rowCount: 1 };
  });
}

function mockProcessedImage() {
  processPrivacyImageMock.mockResolvedValue({
    image: Buffer.from("image"),
    thumbnail: Buffer.from("thumb"),
    width: 100,
    height: 100,
    sha256: "a".repeat(64),
    perceptualHash: "0123456789abcdef",
    detectorRegions: [],
    manualRegions: []
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  readQuarantineObjectMock.mockResolvedValue(Buffer.from("source"));
  writeQuarantineObjectMock.mockResolvedValue(undefined);
  copyToPublicMock.mockResolvedValue(undefined);
  deleteObjectMock.mockResolvedValue(undefined);
  objectExistsMock.mockResolvedValue(false);
  scanForMalwareMock.mockResolvedValue(undefined);
});

describe("recoverStuckPublishing", () => {
  it("reverts stale publishing rows and deletes their deterministic public objects", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { id: "media-1", has_thumbnail: true },
        { id: "media-2", has_thumbnail: false }
      ],
      rowCount: 2
    });
    const { recoverStuckPublishing } = await loadJob();

    await recoverStuckPublishing();

    const [sql] = queryMock.mock.calls[0]!;
    expect(sql).toContain("privacy_status = 'publishing'");
    expect(sql).toContain("SET privacy_status = 'manual_review'");
    const removed = deleteObjectMock.mock.calls.map(([, key]) => key);
    expect(removed).toEqual(["media/media-1.webp", "media/media-1.thumb.webp", "media/media-2.webp"]);
    for (const [bucket] of deleteObjectMock.mock.calls) {
      expect(bucket).toBe("public-bucket");
    }
  });

  it("does not touch storage when no rows were reverted", async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const { recoverStuckPublishing } = await loadJob();

    await recoverStuckPublishing();
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });
});

describe("processMediaJob failure compensation", () => {
  it("removes the partially written quarantine objects when the thumbnail write fails", async () => {
    mockProcessingRow();
    mockProcessedImage();
    writeQuarantineObjectMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("quarantine write failed"));
    const { processMediaJob } = await loadJob();

    await expect(processMediaJob(MEDIA_ID)).rejects.toThrow("quarantine write failed");

    // 已写入的处理图被补偿删除；未配置检测器时不涉及公开对象。
    expect(deleteObjectMock).toHaveBeenCalledTimes(1);
    expect(deleteObjectMock).toHaveBeenCalledWith("quarantine-bucket", `processed/${MEDIA_ID}.webp`);
    const failedUpdate = queryMock.mock.calls.find(([sql]) => sql.includes("privacy_status = 'failed'"));
    expect(failedUpdate).toBeDefined();
    expect(failedUpdate![0]).toContain("privacy_status IN ('scanning', 'processing')");
  });

  it("removes copied public objects when the auto-publish copy partially fails", async () => {
    mockProcessingRow();
    mockProcessedImage();
    copyToPublicMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("public copy failed"));
    const { processMediaJob } = await loadJob({ PRIVACY_DETECTOR_URL: "http://detector.test" });

    await expect(processMediaJob(MEDIA_ID)).rejects.toThrow("public copy failed");

    const removed = deleteObjectMock.mock.calls.map(([bucket, key]) => `${bucket}/${key}`);
    expect(removed).toContain(`public-bucket/media/${MEDIA_ID}.webp`);
    expect(removed).not.toContain(`public-bucket/media/${MEDIA_ID}.thumb.webp`);
    // 本次运行写入的隔离产物也一并补偿。
    expect(removed).toContain(`quarantine-bucket/processed/${MEDIA_ID}.webp`);
    expect(removed).toContain(`quarantine-bucket/processed/${MEDIA_ID}.thumb.webp`);
  });

  it("compensates written objects when the media was deleted mid-flight", async () => {
    mockProcessingRow();
    mockProcessedImage();
    // 定稿 UPDATE 因行已删除而不匹配。
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM media_assets WHERE id = $1")) {
        return {
          rows: [{
            id: MEDIA_ID,
            privacy_status: "processing",
            quarantine_object_key: `quarantine/owner/${MEDIA_ID}.jpg`,
            privacy_report: { manualRegions: [] }
          }],
          rowCount: 1
        };
      }
      if (sql.includes("privacy_status = $2")) return { rows: [], rowCount: 0 };
      return { rows: [{ id: MEDIA_ID }], rowCount: 1 };
    });
    const { processMediaJob } = await loadJob({ PRIVACY_DETECTOR_URL: "http://detector.test" });

    await expect(processMediaJob(MEDIA_ID)).rejects.toThrow("deleted or transitioned");

    const removed = deleteObjectMock.mock.calls.map(([bucket, key]) => `${bucket}/${key}`);
    expect(removed).toContain(`public-bucket/media/${MEDIA_ID}.webp`);
    expect(removed).toContain(`public-bucket/media/${MEDIA_ID}.thumb.webp`);
    expect(removed).toContain(`quarantine-bucket/processed/${MEDIA_ID}.webp`);
  });

  it("skips duplicate jobs that lose the atomic claim", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM media_assets WHERE id = $1")) {
        return {
          rows: [{
            id: MEDIA_ID,
            privacy_status: "processing",
            quarantine_object_key: `quarantine/owner/${MEDIA_ID}.jpg`,
            privacy_report: { manualRegions: [] }
          }],
          rowCount: 1
        };
      }
      // 认领 UPDATE 不匹配：另一个任务已持有该行。
      return { rows: [], rowCount: 0 };
    });
    const { processMediaJob } = await loadJob();

    await processMediaJob(MEDIA_ID);
    expect(readQuarantineObjectMock).not.toHaveBeenCalled();
    expect(writeQuarantineObjectMock).not.toHaveBeenCalled();
  });
});

describe("cleanupDeletedMediaObjects", () => {
  it("also removes deterministic public keys never recorded in the database", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("privacy_status = 'deleted'")) {
        return {
          rows: [{
            id: "media-9",
            quarantine_object_key: "quarantine/owner/media-9.jpg",
            processed_object_key: "processed/media-9.webp",
            thumbnail_object_key: "processed/media-9.thumb.webp",
            public_object_key: null,
            public_thumbnail_object_key: null
          }],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 1 };
    });
    const { cleanupDeletedMediaObjects } = await loadJob();

    await cleanupDeletedMediaObjects();

    const removed = deleteObjectMock.mock.calls.map(([bucket, key]) => `${bucket}/${key}`);
    expect(removed).toContain("public-bucket/media/media-9.webp");
    expect(removed).toContain("public-bucket/media/media-9.thumb.webp");
    expect(removed).toContain("quarantine-bucket/quarantine/owner/media-9.jpg");
  });
});
