import type { ModelBackend, ModelRequest, ModelResult } from "../types.js";
import { callJson, pickUrl } from "./trellis2.js";

/**
 * Hunyuan3D — Tencent's flow-based image-to-3D model.
 *
 * As of 2026-05, the recommended hosted path is **fal-ai/hunyuan3d-v3** (newer
 * than 2.0, has a real maintained endpoint). The Replicate `tencent/hunyuan3d-2`
 * page is a community README without a working hosted version pin, so we don't
 * default to it.
 *
 * Two host modes:
 * 1. fal.ai (default for hosted) — set `FAL_API_KEY` and we hit
 *    `fal-ai/hunyuan3d-v3/image-to-3d` via the fal queue protocol.
 * 2. Self-hosted — set `HUNYUAN3D_ENDPOINT` to a server that accepts
 *    `{prompt, image_url?, detail, seed}` and returns `{glb_url, thumb_url?}`.
 *    This is the path real Hunyuan3D-2 deployments take (Tencent's repo ships
 *    a FastAPI server you stand up on H100/A100).
 *
 *   - HUNYUAN3D_ENDPOINT (self-hosted; takes precedence)
 *   - FAL_API_KEY (hosted via fal)
 *   - HUNYUAN3D_FAL_MODEL (override; default `fal-ai/hunyuan3d-v3/image-to-3d`)
 */
export interface Hunyuan3dConfig {
  endpoint?: string;
  endpointHeaders?: Record<string, string>;
  falApiKey?: string;
  falModel?: string;
  timeoutMs?: number;
  pollMs?: number;
}

export class Hunyuan3dBackend implements ModelBackend {
  readonly name = "hunyuan3d";
  constructor(private cfg: Hunyuan3dConfig = readEnv()) {}
  static fromEnv(env: NodeJS.ProcessEnv): Hunyuan3dBackend { return new Hunyuan3dBackend(readEnv(env)); }
  get available() { return Boolean(this.cfg.endpoint || this.cfg.falApiKey); }

  async generateModel(req: ModelRequest, signal?: AbortSignal): Promise<ModelResult> {
    const started = Date.now();
    if (this.cfg.endpoint) {
      const r = await callJson(this.cfg.endpoint, {
        prompt: req.prompt,
        image_url: req.referenceImageUrl ?? null,
        detail: req.detail ?? "standard",
        seed: req.seed ?? null,
      }, this.cfg.endpointHeaders ?? {}, this.cfg.timeoutMs ?? 5 * 60_000, signal);
      return {
        backend: this.name,
        glbUrl: pickUrl(r, ["glb_url", "model_url", "output", "url"]),
        thumbUrl: typeof r.thumb_url === "string" ? r.thumb_url : undefined,
        durationMs: Date.now() - started,
        raw: r,
      };
    }
    if (!this.cfg.falApiKey) {
      throw new Error("hunyuan3d: no HUNYUAN3D_ENDPOINT and no FAL_API_KEY configured");
    }
    if (!req.referenceImageUrl) {
      throw new Error("hunyuan3d (fal hosted path) requires referenceImageUrl — fal hunyuan3d-v3 is image-only");
    }

    // Use the fal queue protocol (same pattern as fal sam-3d)
    const model = this.cfg.falModel ?? "fal-ai/hunyuan3d-v3/image-to-3d";
    const totalBudget = this.cfg.timeoutMs ?? 5 * 60_000;
    const pollMs = this.cfg.pollMs ?? 2_000;
    const deadline = Date.now() + totalBudget;
    const auth = { authorization: `Key ${this.cfg.falApiKey}` } as const;

    const submitRes = await fetch(`https://queue.fal.run/${model}`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        input_image_url: req.referenceImageUrl,
        prompt: req.prompt,
      }),
      signal,
    });
    if (!submitRes.ok) {
      const text = await submitRes.text().catch(() => "");
      throw new Error(`hunyuan3d submit ${submitRes.status}: ${text.slice(0, 400)}`);
    }
    const submit = (await submitRes.json()) as { request_id: string; status_url: string; response_url: string };
    if (!submit.status_url || !submit.response_url) {
      throw new Error(`hunyuan3d: queue submit missing status_url/response_url`);
    }

    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("hunyuan3d: aborted");
      await sleep(pollMs);
      const sr = await fetch(submit.status_url, { headers: auth, signal });
      if (!sr.ok) {
        const text = await sr.text().catch(() => "");
        throw new Error(`hunyuan3d status ${sr.status}: ${text.slice(0, 400)}`);
      }
      const status = (await sr.json()) as { status?: string };
      const s = status.status;
      if (s === "COMPLETED") break;
      if (s === "FAILED" || s === "CANCELLED" || s === "CANCELED") {
        throw new Error(`hunyuan3d ${s}: ${JSON.stringify(status).slice(0, 300)}`);
      }
      if (Date.now() >= deadline) throw new Error("hunyuan3d: timed out");
    }

    const rr = await fetch(submit.response_url, { headers: auth, signal });
    if (!rr.ok) {
      const text = await rr.text().catch(() => "");
      throw new Error(`hunyuan3d result ${rr.status}: ${text.slice(0, 400)}`);
    }
    const r = (await rr.json()) as any;
    const glbUrl: string | undefined = r.model_mesh?.url ?? r.model_glb?.url ?? r.glb?.url ?? r.model_url ?? r.glb_url;
    if (!glbUrl) {
      throw new Error(`hunyuan3d: no GLB url in result: ${JSON.stringify(r).slice(0, 400)}`);
    }
    return {
      backend: this.name,
      glbUrl,
      thumbUrl: r.preview_url ?? r.rendered_image?.url,
      durationMs: Date.now() - started,
      raw: r,
    };
  }
}

function readEnv(env: NodeJS.ProcessEnv = process.env): Hunyuan3dConfig {
  return {
    endpoint: env.HUNYUAN3D_ENDPOINT,
    endpointHeaders: env.HUNYUAN3D_AUTH ? { authorization: env.HUNYUAN3D_AUTH } : undefined,
    falApiKey: env.FAL_API_KEY ?? env.FAL_KEY,
    falModel: env.HUNYUAN3D_FAL_MODEL,
  };
}
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
