<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { categoryKeys, type CategoryKey } from "@map/shared/contracts";
import LocationPicker from "../components/LocationPicker.vue";
import PrivacyImageUploader from "../components/PrivacyImageUploader.vue";
import { apiFetch } from "../lib/api";

type Category = { key: CategoryKey; name: string };
type MediaResult = { id: string; status: string; url: string | null; thumbnailUrl: string | null };
type UploadItem = { file?: File; media?: MediaResult };
type FieldDefinition = {
  key: string;
  label: string;
  type: "text" | "number" | "select";
  options?: Array<{ value: string; label: string }>;
};

const categoryFields: Record<CategoryKey, FieldDefinition[]> = {
  bench: [
    { key: "seatCount", label: "座位数", type: "number" },
    { key: "hasBackrest", label: "有靠背", type: "select", options: [] },
    { key: "covered", label: "有遮蔽", type: "select", options: [] },
    { key: "shaded", label: "有树荫", type: "select", options: [] },
    { key: "wheelchairSpace", label: "有轮椅空间", type: "select", options: [] },
    { key: "material", label: "材质", type: "text" }
  ],
  drinking_water: [
    { key: "potable", label: "是否可饮用", type: "select", options: [{ value: "yes", label: "可饮用" }, { value: "no", label: "不可饮用" }, { value: "unknown", label: "未知" }] },
    { key: "waterType", label: "出水类型", type: "select", options: [{ value: "fountain", label: "直饮水机" }, { value: "bottle_filler", label: "可接瓶" }, { value: "tap", label: "水龙头" }, { value: "unknown", label: "未知" }] },
    { key: "bottleFiller", label: "可接水杯/瓶", type: "select", options: [] },
    { key: "working", label: "当前可用", type: "select", options: [{ value: "yes", label: "可用" }, { value: "no", label: "不可用" }, { value: "unknown", label: "未知" }] },
    { key: "pressure", label: "水压", type: "select", options: [{ value: "low", label: "低" }, { value: "normal", label: "正常" }, { value: "high", label: "高" }, { value: "unknown", label: "未知" }] }
  ],
  rain_shelter: [
    { key: "capacity", label: "容纳人数", type: "number" },
    { key: "windProtection", label: "挡风程度", type: "select", options: [{ value: "none", label: "无" }, { value: "partial", label: "部分" }, { value: "strong", label: "强" }, { value: "unknown", label: "未知" }] },
    { key: "seating", label: "有座位", type: "select", options: [] },
    { key: "flooding", label: "容易积水", type: "select", options: [{ value: "yes", label: "会" }, { value: "no", label: "不会" }, { value: "unknown", label: "未知" }] },
    { key: "structureNotes", label: "结构备注", type: "text" }
  ],
  quiet_corner: [
    { key: "seating", label: "有座位", type: "select", options: [] },
    { key: "powerOutlet", label: "有电源", type: "select", options: [] },
    { key: "wifi", label: "有 Wi-Fi", type: "select", options: [] },
    { key: "crowdLevel", label: "拥挤程度", type: "select", options: [{ value: "empty", label: "几乎无人" }, { value: "low", label: "较少" }, { value: "medium", label: "中等" }, { value: "high", label: "很多" }, { value: "unknown", label: "未知" }] },
    { key: "bestTimes", label: "推荐时段", type: "text" }
  ],
  night_lighting: [
    { key: "brightness", label: "亮度（1-5）", type: "number" },
    { key: "coverage", label: "覆盖范围", type: "select", options: [{ value: "tiny", label: "很小" }, { value: "partial", label: "部分" }, { value: "wide", label: "很广" }, { value: "unknown", label: "未知" }] },
    { key: "colorTemperature", label: "光色", type: "select", options: [{ value: "warm", label: "暖色" }, { value: "neutral", label: "中性" }, { value: "cold", label: "冷色" }, { value: "unknown", label: "未知" }] },
    { key: "lightType", label: "灯具类型", type: "text" },
    { key: "operatingHours", label: "亮灯时段", type: "text" },
    { key: "brokenLights", label: "损坏灯数", type: "number" }
  ]
};

const route = useRoute();
const router = useRouter();
const editId = computed(() => typeof route.params.id === "string" ? route.params.id : null);
const categories = ref<Category[]>([]);
const uploads = ref<UploadItem[]>([]);
const error = ref("");
const success = ref("");
const busy = ref(false);
const loadedFeatureStatus = ref("");

const form = reactive({
  categoryKey: categoryKeys[0] as CategoryKey,
  title: "",
  description: "",
  longitude: 116.397,
  latitude: 39.908,
  locationAccuracyM: 10,
  observedAt: new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16),
  condition: "good",
  stepFree: "",
  wheelchairAccessible: "",
  noiseLevel: "",
  tags: ""
});
const details = reactive<Record<string, string>>({});

const fields = computed(() => categoryFields[form.categoryKey] ?? []);

function toLocalDateTimeInput(value: string | Date): string {
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

const location = computed({
  get: (): [number, number] => [form.longitude, form.latitude],
  set: (value: [number, number]) => { form.longitude = value[0]; form.latitude = value[1]; }
});

function resetDetails() {
  for (const key of Object.keys(details)) delete details[key];
  for (const field of fields.value) {
    if (field.type === "select" && field.options?.length) details[field.key] = field.options[0]!.value;
    else if (field.type === "select") details[field.key] = "";
    else details[field.key] = "";
  }
}

function parseOptionalBoolean(value: string): boolean | null {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function parseOptionalNumber(value: string): number | null {
  if (value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function buildDetails() {
  const result: Record<string, unknown> = {};
  for (const field of fields.value) {
    const raw = details[field.key] ?? "";
    if (field.type === "select" && !field.options?.length) {
      const value = parseOptionalBoolean(raw);
      if (value !== null) result[field.key] = value;
      continue;
    }
    if (raw === "") continue;
    result[field.key] = field.type === "number" ? parseOptionalNumber(raw) : raw;
  }
  return result;
}

function onFilesSelected(event: Event) {
  const input = event.target as HTMLInputElement;
  const selected = Array.from(input.files ?? []);
  if (uploads.value.length + selected.length > 6) {
    error.value = "每条内容最多上传 6 张图片。";
    return;
  }
  uploads.value.push(...selected.map((file) => ({ file })));
  input.value = "";
}

async function removeUpload(index: number) {
  const media = uploads.value[index]?.media;
  if (media) await apiFetch(`/media/${media.id}`, { method: "DELETE" }).catch(() => undefined);
  uploads.value.splice(index, 1);
}

function recordMedia(index: number, media: MediaResult) {
  const upload = uploads.value[index];
  if (upload) upload.media = media;
}

async function loadExisting() {
  if (!editId.value) return;
  const feature = await apiFetch<Record<string, any>>(`/features/${editId.value}`);
  loadedFeatureStatus.value = feature.status;
  form.categoryKey = feature.categoryKey;
  form.title = feature.title;
  form.description = feature.description;
  form.longitude = feature.longitude;
  form.latitude = feature.latitude;
  form.locationAccuracyM = feature.locationAccuracyM;
  form.observedAt = toLocalDateTimeInput(feature.observedAt);
  form.condition = feature.condition;
  form.stepFree = feature.stepFree === true ? "true" : feature.stepFree === false ? "false" : "";
  form.wheelchairAccessible = feature.wheelchairAccessible === true ? "true" : feature.wheelchairAccessible === false ? "false" : "";
  form.noiseLevel = feature.noiseLevel ? String(feature.noiseLevel) : "";
  form.tags = (feature.tags ?? []).join(", ");
  resetDetails();
  for (const [key, value] of Object.entries(feature.details ?? {})) {
    details[key] = value === null || value === undefined ? "" : String(value);
  }
  uploads.value = (feature.media ?? []).map((item: MediaResult) => ({ media: item }));
}

async function submit() {
  error.value = "";
  success.value = "";
  if (!form.title.trim() || form.description.trim().length < 10) {
    error.value = "标题不能为空，说明至少 10 个字符。";
    return;
  }
  const mediaItems = uploads.value.map((item) => item.media).filter((item): item is MediaResult => Boolean(item));
  if (mediaItems.length !== uploads.value.length) {
    error.value = "请等待所有图片完成服务端隐私处理。";
    return;
  }
  if (mediaItems.some((item) => !["ready", "manual_review", "publishing"].includes(item.status))) {
    error.value = "有图片仍在处理或处理失败。";
    return;
  }

  const payload = {
    categoryKey: form.categoryKey,
    title: form.title,
    description: form.description,
    longitude: Number(form.longitude),
    latitude: Number(form.latitude),
    locationAccuracyM: Number(form.locationAccuracyM),
    observedAt: new Date(form.observedAt).toISOString(),
    condition: form.condition,
    stepFree: parseOptionalBoolean(form.stepFree),
    wheelchairAccessible: parseOptionalBoolean(form.wheelchairAccessible),
    noiseLevel: parseOptionalNumber(form.noiseLevel),
    tags: form.tags.split(",").map((item) => item.trim()).filter(Boolean),
    details: buildDetails(),
    mediaIds: mediaItems.map((item) => item.id)
  };

  busy.value = true;
  try {
    let featureId = editId.value;
    if (!featureId) {
      const created = await apiFetch<{ id: string }>("/features", { method: "POST", body: payload });
      featureId = created.id;
      await apiFetch(`/features/${featureId}/submit`, { method: "POST" });
    } else if (["draft", "rejected", "changes_requested"].includes(loadedFeatureStatus.value)) {
      await apiFetch(`/features/${featureId}/draft`, { method: "PATCH", body: payload });
      await apiFetch(`/features/${featureId}/submit`, { method: "POST" });
    } else {
      const revision = await apiFetch<{ id: string }>(`/features/${featureId}/revisions`, { method: "POST", body: payload });
      await apiFetch(`/features/${featureId}/revisions/${revision.id}/submit`, { method: "POST" });
    }
    success.value = "已提交审核。审核通过前不会出现在公共地图。";
    setTimeout(() => void router.push("/me/contributions"), 900);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "提交失败";
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  categories.value = await apiFetch<Category[]>("/categories");
  resetDetails();
  await loadExisting().catch((cause) => { error.value = cause instanceof Error ? cause.message : "加载投稿失败"; });
});
</script>

<template>
  <section>
    <div class="page-heading">
      <div>
        <h1>{{ editId ? "修改地点细节" : "记录一个地点细节" }}</h1>
        <p>所有投稿先进入审核；照片在公开前由 Node.js 服务端完成隐私处理。</p>
      </div>
    </div>

    <div v-if="error" class="error-box">{{ error }}</div>
    <div v-if="success" class="success-box">{{ success }}</div>

    <div class="stack">
      <section class="card"><div class="card-body">
        <h2>1. 位置</h2>
        <p class="muted">点击地图或拖动标记。不要把私人住宅内部或不可公开进入的地点作为目标。</p>
        <LocationPicker v-model="location" />
        <div class="grid-3" style="margin-top: 14px">
          <div class="field"><label>经度</label><input v-model.number="form.longitude" type="number" step="0.000001" /></div>
          <div class="field"><label>纬度</label><input v-model.number="form.latitude" type="number" step="0.000001" /></div>
          <div class="field"><label>位置准确度（米）</label><input v-model.number="form.locationAccuracyM" type="number" min="3" max="100" /></div>
        </div>
      </div></section>

      <section class="card"><div class="card-body">
        <h2>2. 基本信息</h2>
        <div class="grid-2">
          <div class="field"><label>分类</label>
            <select v-model="form.categoryKey" @change="resetDetails">
              <option v-for="category in categories" :key="category.key" :value="category.key">{{ category.name }}</option>
            </select>
          </div>
          <div class="field"><label>观察时间</label><input v-model="form.observedAt" type="datetime-local" /></div>
        </div>
        <div class="field"><label>标题</label><input v-model="form.title" maxlength="80" placeholder="例如：公园南门有靠背长椅" /></div>
        <div class="field"><label>实际体验说明</label><textarea v-model="form.description" maxlength="2000" placeholder="说明什么时候来、实际是否好用、有什么注意事项。" /></div>
        <div class="grid-3">
          <div class="field"><label>总体状况</label>
            <select v-model="form.condition"><option value="good">良好</option><option value="fair">一般</option><option value="poor">较差</option><option value="unknown">未知</option></select>
          </div>
          <div class="field"><label>无台阶到达</label>
            <select v-model="form.stepFree"><option value="">未知</option><option value="true">是</option><option value="false">否</option></select>
          </div>
          <div class="field"><label>轮椅可用</label>
            <select v-model="form.wheelchairAccessible"><option value="">未知</option><option value="true">是</option><option value="false">否</option></select>
          </div>
        </div>
        <div class="field"><label>标签（逗号分隔）</label><input v-model="form.tags" placeholder="遮阳, 休息, 无障碍" /></div>
      </div></section>

      <section class="card"><div class="card-body">
        <h2>3. 分类细节</h2>
        <div class="grid-2">
          <div v-for="field in fields" :key="field.key" class="field">
            <label :for="`detail-${field.key}`">{{ field.label }}</label>
            <select v-if="field.type === 'select'" :id="`detail-${field.key}`" v-model="details[field.key]">
              <template v-if="field.options?.length">
                <option v-for="option in field.options" :key="option.value" :value="option.value">{{ option.label }}</option>
              </template>
              <template v-else>
                <option value="">未知</option><option value="true">是</option><option value="false">否</option>
              </template>
            </select>
            <input v-else :id="`detail-${field.key}`" v-model="details[field.key]" :type="field.type" />
          </div>
        </div>
      </div></section>

      <section class="card"><div class="card-body">
        <h2>4. 照片与隐私</h2>
        <p class="muted">最多 6 张。原图只进入私有隔离区；公开版本由服务端模糊、重编码并移除 EXIF/GPS。</p>
        <input type="file" accept="image/jpeg,image/png,image/webp" multiple @change="onFilesSelected" />
        <div class="stack" style="margin-top: 14px">
          <template v-for="(upload, index) in uploads" :key="upload.file ? `${upload.file.name}-${upload.file.lastModified}-${upload.file.size}` : `existing-${upload.media?.id ?? index}`">
            <PrivacyImageUploader
              v-if="upload.file"
              :file="upload.file"
              @processed="recordMedia(index, $event)"
              @remove="removeUpload(index)"
            />
            <article v-else class="uploader">
              <div class="inline" style="justify-content: space-between">
                <div>
                  <strong>已有图片</strong>
                  <div class="muted">状态：{{ upload.media?.status ?? "unknown" }}</div>
                </div>
                <button class="button ghost small" type="button" @click="removeUpload(index)">移除</button>
              </div>
            </article>
          </template>
        </div>
      </div></section>

      <section class="card"><div class="card-body">
        <h2>5. 提交审核</h2>
        <p class="muted">提交即表示内容基于真实观察，且不包含未经处理的不当个人信息。</p>
        <div class="inline">
          <button class="button" type="button" :disabled="busy" @click="submit">{{ busy ? "提交中…" : "提交审核" }}</button>
          <RouterLink class="button ghost" to="/me/contributions">返回我的内容</RouterLink>
        </div>
      </div></section>
    </div>
  </section>
</template>
