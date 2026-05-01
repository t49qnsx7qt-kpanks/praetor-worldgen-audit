import type { ModelBackend, ModelRequest, ModelResult } from "../types.js";

/**
 * TRELLIS-2 — Microsoft Research's native 3D generative model. Outputs GLB
 * with PBR textures. Two host modes:
 *
 * 1. Replicate (default) — set `REPLICATE_API_TOKEN`. Uses the public
 *    `firtoz/trellis` model. Image-only — pure-text prompts will be rejected.
 * 2. Self-hosted — set `TRELLIS2_ENDPOINT` to a server that accepts
 *    `{prompt, image_url?, detail}` and returns `{glb_url, thumb_url}`.
 *
 * Spec verified 2026-05 against https://replicate.com/firtoz/trellis/api
 */
export interface Trellis2Config {
  replicateToken?: string;
  /** Override the Replicate model slug (e.g. for a private finetune). */
  replicateModel?: string;
  /** Optional self-hosted endpoint URL; takes precedence over Replicate. */
  endpoint?: string;
  /** Headers for the self-hosted endpoint. */
  endpointHeaders?: Record<string, string>;
  /** Per-call timeout in ms. Default 5 min. */
  timeoutMs?: number;
}

const DEFAULT_REPLICATE_MODEL = "firtoz/trellis:e8f6c45206993f297372f5436b90350817bd9b4a0d52d2a76df50c1c8afa2b3c";

export class Trellis2Backend implements ModelBackend {
  readonly name = "trellis2";
  constructor(private cfg: Trellis2Config = readEnv()) {}
  static fromEnv(env: NodeJS.ProcessEnv): Trellis2Backend { return new Trellis2Backend(readEnv(env)); }

  get available() {
    return Boolean(this.cfg.endpoint || this.cfg.replicateToken);
  }

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
        thumbUrl: pickUrl(r, ["thumb_url", "preview_url"]) || undefined,
        polyCount: typeof r.poly_count === "number" ? r.poly_count : undefined,
        textureRes: typeof r.texture_res === "number" ? r.texture_res : undefined,
        durationMs: Date.now() - started,
        raw: r,
      };
    }
    if (!this.cfg.replicateToken) {
      throw new Error("trellis2: no endpoint and no REPLICATE_API_TOKEN configured");
    }
    if (!req.referenceImageUrl) {
      throw new Error("trellis2: firtoz/trellis on Replicate is image-only — provide referenceImageUrl, or set TRELLIS2_ENDPOINT for a text-capable host");
    }
    const out = await runReplicate(
      this.cfg.replicateToken,
      this.cfg.replicateModel ?? DEFAULT_REPLICATE_MODEL,
      {
        // Real schema: `images` is an ARRAY, and `generate_model` MUST be true to get a GLB
        images: [req.referenceImageUrl],
        generate_model: true,
        generate_color: true,
        generate_normal: false,
        seed: req.seed ?? 0,
        randomize_seed: req.seed == null,
        texture_size: detailToTextureSize(req.detail ?? "standard"),
        mesh_simplify: detailToMeshSimplify(req.detail ?? "standard"),
        ss_sampling_steps: 12,
        slat_sampling_steps: 12,
        ss_guidance_strength: 7.5,
        slat_guidance_strength: 3,
      },
      this.cfg.timeoutMs ?? 5 * 60_000,
      signal,
    );
    // Real output is an OBJECT: { model_file, color_video, normal_video, no_background_images }
    const output = out.output as Record<string, unknown> | undefined;
    const glbUrl = typeof output?.model_file === "string"
      ? output.model_file
      : pickReplicateGlb(out);
    const thumbUrl = pickReplicateThumb(out);
    return {
      backend: this.name,
      glbUrl,
      thumbUrl: thumbUrl || undefined,
      durationMs: Date.now() - started,
      raw: { replicateOutput: out },
    };
  }
}

function readEnv(env: NodeJS.ProcessEnv = process.env): Trellis2Config {
  return {
    replicateToken: env.REPLICATE_API_TOKEN,
    replicateModel: env.TRELLIS2_REPLICATE_MODEL,
    endpoint: env.TRELLIS2_ENDPOINT,
    endpointHeaders: env.TRELLIS2_AUTH ? { authorization: env.TRELLIS2_AUTH } : undefined,
  };
}

/* ---------- shared helpers (also used by other backends) ---------- */

export async function callJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Record<string, any>> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  if (signal) signal.addEventListener("abort", () => ac.abort(), { once: true });
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`POST ${url} -> ${res.status}: ${text.slice(0, 400)}`);
    }
    return (await res.json()) as Record<string, any>;
  } finally {
    clearTimeout(timer);
  }
}

export function pickUrl(obj: Record<string, any>, keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
    if (Array.isArray(v) && typeof v[0] === "string") return v[0];
    // Some APIs nest at { key: { url: "..." } }
    if (v && typeof v === "object" && typeof v.url === "string") return v.url;
  }
  throw new Error(`response missing one of: ${keys.join(", ")}`);
}

/**
 * Runs a Replicate prediction to completion. Replicate's standard async flow:
 * POST /predictions -> poll GET /predictions/:id until status is succeeded|failed|canceled.
 *
 * Slug forms accepted:
 *   "owner/name"               -> POST /v1/models/owner/name/predictions
 *   "owner/name:version_hash"  -> POST /v1/predictions  with { version, input }
 */
export async function runReplicate(
  token: string,
  model: string,
  input: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ status: string; output: unknown; metrics?: any; error?: string }> {
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const colonIdx = model.indexOf(":");
  const isVersioned = colonIdx >= 0;
  const slug = isVersioned ? model.slice(0, colonIdx) : model;
  const version = isVersioned ? model.slice(colonIdx + 1) : null;
  const url = version ? "https://api.replicate.com/v1/predictions" : `https://api.replicate.com/v1/models/${slug}/predictions`;
  const body = version ? { version, input } : { input };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  if (signal) signal.addEventListener("abort", () => ac.abort(), { once: true });
  try {
    const created = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: ac.signal });
    if (!created.ok) {
      const text = await created.text().catch(() => "");
      throw new Error(`replicate POST ${url} -> ${created.status}: ${text.slice(0, 400)}`);
    }
    let pred = (await created.json()) as { id: string; status: string; output?: unknown; error?: string };
    while (pred.status !== "succeeded" && pred.status !== "failed" && pred.status !== "canceled") {
      await sleep(1500);
      const r = await fetch(`https://api.replicate.com/v1/predictions/${pred.id}`, { headers, signal: ac.signal });
      if (!r.ok) throw new Error(`replicate poll ${r.status}`);
      pred = (await r.json()) as typeof pred;
    }
    if (pred.status !== "succeeded") {
      throw new Error(`replicate prediction ${pred.status}: ${pred.error ?? "unknown"}`);
    }
    return pred as { status: string; output: unknown };
  } finally {
    clearTimeout(timer);
  }
}

function pickReplicateGlb(out: { output: unknown }): string {
  // Prefer .glb urls in any string|array|object.
  const candidates = collectStrings(out.output).filter((s) => s.endsWith(".glb") || s.endsWith(".gltf"));
  if (candidates[0]) return candidates[0];
  const all = collectStrings(out.output);
  if (all[0]) return all[0];
  throw new Error("replicate output had no GLB url");
}

function pickReplicateThumb(out: { output: unknown }): string | undefined {
  const candidates = collectStrings(out.output).filter((s) => /\.(png|jpg|jpeg|webp)$/i.test(s));
  return candidates[0];
}

function collectStrings(v: unknown): string[] {
  if (!v) return [];
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(collectStrings);
  if (typeof v === "object") return Object.values(v as Record<string, unknown>).flatMap(collectStrings);
  return [];
}

function detailToTextureSize(d: "draft" | "standard" | "high"): number {
  return d === "draft" ? 512 : d === "high" ? 2048 : 1024;
}

function detailToMeshSimplify(d: "draft" | "standard" | "high"): number {
  return d === "draft" ? 0.95 : d === "high" ? 0.9 : 0.92;
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
