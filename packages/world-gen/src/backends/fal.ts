import type { ModelBackend, ModelRequest, ModelResult } from "../types.js";

/**
 * fal.ai sam-3/3d-objects — Meta SAM-3 segments the input image, then a
 * dedicated 3D head reconstructs a GLB + Gaussian splat. Image-only.
 *
 * Spec verified 2026-05 against https://fal.ai/models/fal-ai/sam-3/3d-objects/api
 *
 * Async queue API (fal does not expose a sync mode for this model):
 *   POST https://queue.fal.run/{model}             -> { request_id, status_url, response_url }
 *   GET  status_url                                 -> { status: "IN_QUEUE"|"IN_PROGRESS"|"COMPLETED"|"FAILED", logs }
 *   GET  response_url                               -> result body
 *
 * Auth: `Authorization: Key ${FAL_KEY}` on all three calls.
 *
 *   - FAL_API_KEY (or FAL_KEY) required
 *   - FAL_MODEL: optional override (default `fal-ai/sam-3/3d-objects`)
 */
export interface FalConfig {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  pollMs?: number;
}

export class FalSam3dBackend implements ModelBackend {
  readonly name = "fal-sam-3d";
  constructor(private cfg: FalConfig = readEnv()) {}
  static fromEnv(env: NodeJS.ProcessEnv): FalSam3dBackend { return new FalSam3dBackend(readEnv(env)); }
  get available() { return Boolean(this.cfg.apiKey); }

  async generateModel(req: ModelRequest, signal?: AbortSignal): Promise<ModelResult> {
    if (!this.cfg.apiKey) throw new Error("fal: FAL_API_KEY is not set");
    if (!req.referenceImageUrl) throw new Error("fal-sam-3d: requires referenceImageUrl (image-driven only)");

    const started = Date.now();
    const model = this.cfg.model ?? "fal-ai/sam-3/3d-objects";
    const totalBudget = this.cfg.timeoutMs ?? 5 * 60_000;
    const pollMs = this.cfg.pollMs ?? 2_000;
    const deadline = Date.now() + totalBudget;
    const auth = { authorization: `Key ${this.cfg.apiKey}` } as const;

    // 1) Submit to the queue
    const submitUrl = `https://queue.fal.run/${model}`;
    const submitRes = await fetch(submitUrl, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        image_url: req.referenceImageUrl,
        prompt: req.prompt,
      }),
      signal,
    });
    if (!submitRes.ok) {
      const text = await submitRes.text().catch(() => "");
      throw new Error(`fal submit ${submitRes.status}: ${text.slice(0, 400)}`);
    }
    const submit = (await submitRes.json()) as { request_id: string; status_url: string; response_url: string };
    if (!submit.status_url || !submit.response_url) {
      throw new Error(`fal: queue submit response missing status_url/response_url: ${JSON.stringify(submit).slice(0, 300)}`);
    }

    // 2) Poll status
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("fal: aborted");
      await sleep(pollMs);
      const sr = await fetch(submit.status_url, { headers: auth, signal });
      if (!sr.ok) {
        const text = await sr.text().catch(() => "");
        throw new Error(`fal status ${sr.status}: ${text.slice(0, 400)}`);
      }
      const status = (await sr.json()) as { status?: string };
      const s = status.status;
      if (s === "COMPLETED") break;
      if (s === "FAILED" || s === "CANCELLED" || s === "CANCELED") {
        throw new Error(`fal request ${s}: ${JSON.stringify(status).slice(0, 300)}`);
      }
      if (Date.now() >= deadline) throw new Error("fal: timed out");
    }

    // 3) Fetch the result
    const rr = await fetch(submit.response_url, { headers: auth, signal });
    if (!rr.ok) {
      const text = await rr.text().catch(() => "");
      throw new Error(`fal result ${rr.status}: ${text.slice(0, 400)}`);
    }
    const r = (await rr.json()) as any;
    // SAM-3D output:
    //   { gaussian_splat: { url }, model_glb: { url }, per_object_metadata: [...] }
    const glbUrl: string | undefined = r.model_glb?.url ?? r.glb?.url ?? r.model_url ?? r.glb_url;
    if (!glbUrl) {
      throw new Error(`fal-sam-3d: no GLB url in result: ${JSON.stringify(r).slice(0, 400)}`);
    }
    return {
      backend: this.name,
      glbUrl,
      thumbUrl: r.preview_url ?? r.thumbnail_url,
      durationMs: Date.now() - started,
      raw: r,
    };
  }
}

function readEnv(env: NodeJS.ProcessEnv = process.env): FalConfig {
  return {
    apiKey: env.FAL_API_KEY ?? env.FAL_KEY,
    model: env.FAL_MODEL,
  };
}
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
