import type { ModelBackend, ModelRequest, ModelResult } from "../types.js";
import { callJson } from "./trellis2.js";

/**
 * Tripo AI — fastest hosted text-to-GLB. Used as the "draft" tier when speed
 * matters more than fidelity.
 *
 * Spec verified 2026-05 against https://platform.tripo3d.ai/docs
 *
 * Single endpoint:
 *   POST https://api.tripo3d.ai/v2/openapi/task
 *   Body: { type: "text_to_model"|"image_to_model", prompt?, image_token?, model_version? }
 *   Response: { code: 0, data: { task_id } }
 *   Poll: GET https://api.tripo3d.ai/v2/openapi/task/{task_id}
 *   Response: { code: 0, data: { status, progress, result: {...}, ...} }
 *
 *   - TRIPO_API_KEY (required) — starts with "tsk_"
 *   - TRIPO_BASE_URL (optional; defaults to https://api.tripo3d.ai/v2/openapi)
 *   - TRIPO_MODEL_VERSION (optional; defaults to "v2.5")
 */
export interface TripoConfig {
  apiKey?: string;
  baseUrl?: string;
  modelVersion?: string;
  timeoutMs?: number;
}

export class TripoBackend implements ModelBackend {
  readonly name = "tripo";
  constructor(private cfg: TripoConfig = readEnv()) {}
  static fromEnv(env: NodeJS.ProcessEnv): TripoBackend { return new TripoBackend(readEnv(env)); }
  get available() { return Boolean(this.cfg.apiKey); }

  async generateModel(req: ModelRequest, signal?: AbortSignal): Promise<ModelResult> {
    if (!this.cfg.apiKey) throw new Error("tripo: TRIPO_API_KEY is not set");
    const started = Date.now();
    const base = (this.cfg.baseUrl ?? "https://api.tripo3d.ai/v2/openapi").replace(/\/+$/, "");
    const headers = { authorization: `Bearer ${this.cfg.apiKey}` };

    // Single endpoint, type discriminates
    const submitBody: Record<string, unknown> = req.referenceImageUrl
      ? { type: "image_to_model", image: { type: "url", url: req.referenceImageUrl }, prompt: req.prompt }
      : { type: "text_to_model", prompt: req.prompt };

    submitBody.model_version = this.cfg.modelVersion ?? "v2.5";
    submitBody.face_limit = req.detail === "draft" ? 5_000 : req.detail === "high" ? 30_000 : 10_000;
    if (typeof req.seed === "number") submitBody.seed = req.seed;

    // 1) submit
    const submit = await callJson(`${base}/task`, submitBody, headers, this.cfg.timeoutMs ?? 60_000, signal);
    if (submit.code !== 0 && submit.code !== undefined) {
      throw new Error(`tripo submit code=${submit.code}: ${submit.message ?? JSON.stringify(submit).slice(0, 300)}`);
    }
    const taskId = submit.data?.task_id ?? submit.task_id;
    if (!taskId) throw new Error(`tripo: missing task_id in submit response: ${JSON.stringify(submit).slice(0, 300)}`);

    // 2) poll
    const deadline = Date.now() + (this.cfg.timeoutMs ?? 5 * 60_000);
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("tripo: aborted");
      await sleep(2000);
      const r = await fetch(`${base}/task/${taskId}`, { headers });
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        throw new Error(`tripo poll ${r.status}: ${text.slice(0, 300)}`);
      }
      const json = (await r.json()) as any;
      if (json.code !== 0 && json.code !== undefined) {
        throw new Error(`tripo poll code=${json.code}: ${json.message ?? JSON.stringify(json).slice(0, 300)}`);
      }
      const data = json.data ?? json;
      const status: string = data.status ?? data.state;
      if (status === "success" || status === "completed") {
        const glbUrl = data.output?.pbr_model
          ?? data.output?.model
          ?? data.result?.pbr_model?.url
          ?? data.result?.model?.url
          ?? data.result?.glb_url;
        if (!glbUrl) throw new Error(`tripo: response had no GLB url: ${JSON.stringify(data).slice(0, 400)}`);
        return {
          backend: this.name,
          glbUrl,
          thumbUrl: data.output?.rendered_image ?? data.result?.rendered_image?.url,
          durationMs: Date.now() - started,
          raw: data,
        };
      }
      if (status === "failed" || status === "error" || status === "cancelled" || status === "canceled") {
        throw new Error(`tripo task ${status}: ${JSON.stringify(data).slice(0, 300)}`);
      }
      // status: queued | running — keep polling
    }
    throw new Error("tripo: timed out");
  }
}

function readEnv(env: NodeJS.ProcessEnv = process.env): TripoConfig {
  return {
    apiKey: env.TRIPO_API_KEY,
    baseUrl: env.TRIPO_BASE_URL,
    modelVersion: env.TRIPO_MODEL_VERSION,
  };
}
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
