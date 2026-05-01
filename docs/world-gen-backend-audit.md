# Backend Spec Audit — Phase C Findings

## 1. TRELLIS-2 (Replicate fallback) — 4 BUGS

**Real spec** (https://replicate.com/firtoz/trellis):
- Input field: `images` (ARRAY of URLs), NOT `image` (single string)
- Field for GLB: must set `generate_model: true` (defaults to FALSE — without this, NO GLB is produced)
- Output is an OBJECT: `{ model_file: uri, color_video: uri, no_background_images: [...], ... }`, NOT an array of strings
- Auth header: Replicate accepts `Token <token>` AND `Bearer <token>`; ours uses `Token` which is fine (legacy, still supported) but `Bearer` is current best practice. Not a bug.

**Our bugs:**
1. Send `image` instead of `images: [url]` → API returns 422 immediately
2. Don't pass `generate_model: true` → would receive videos but no GLB; our `pickReplicateGlb` would throw "no GLB url"
3. Don't pass `randomize_seed: false` when seed is given → seed is silently ignored
4. `splitVersioned()` logic backwards — when slug contains `:`, the part BEFORE the colon is the model name (`firtoz/trellis`) and AFTER is the version. Our code returns owner=`firtoz/trellis`, rest=`version`, then sends `{version: rest, input}` to `/v1/predictions` — that's actually correct by accident, but `owner` is misleadingly named.

## 2. Hunyuan3D — DOES NOT EXIST AS REPLICATE MODEL

**Reality check:** `tencent/hunyuan3d-2` on Replicate listing exists but per multiple checks it's a community-uploaded README-only entry; the actual inference path Tencent recommends is **self-hosted** via the `Hunyuan3D-2` GitHub project (a Python package + optional FastAPI server you stand up yourself). For a hosted alternative, **fal.ai now hosts `hunyuan3d-v3`** (newer + better than 2.0).

**Our bugs:**
1. We default `replicateModel: "tencent/hunyuan3d-2"` without a version pin, which will 404 or error
2. We send `caption` field — that's unused; real input is `image` (the README is image-to-3D only; text-to-3D goes through their separate `Hunyuan3D-DiT` text encoder)
3. Replicate fallback path will fail on first run

**Recommendation:** Replace the Replicate fallback with **fal-ai/hunyuan3d-v3/image-to-3d** (which has a real, current API — same fal client we're already using). Keep `HUNYUAN3D_ENDPOINT` for self-hosted users.

## 3. Tripo — 1 SERIOUS BUG, 1 MINOR

**Real spec** (https://platform.tripo3d.ai/docs):
- Single endpoint: `POST https://api.tripo3d.ai/v2/openapi/task` (NO `/text_to_model` or `/image_to_model` sub-paths)
- Discriminator is the `type` field in the body: `"text_to_model"` or `"image_to_model"`
- Auth: `Authorization: Bearer ${TRIPO_API_KEY}` ✓ (we have this right)
- Polling: `GET /task/{task_id}` ✓
- `model_version` recommended value is `"v2.5"`, not `"v2.0-20240919"`

**Our bugs:**
1. **CRITICAL**: We POST to `/task/text_to_model` — that path does not exist. Real path is `/task` with body `{ type: "text_to_model", prompt }`. → 404 on every call
2. `model_version: "v2.0-20240919"` is stale; should be `"v2.5"` (or omit and let Tripo default)

## 4. fal sam-3d — 2 BUGS

**Real spec** (https://fal.ai/models/fal-ai/sam-3/3d-objects/api):
- Endpoint: `POST https://queue.fal.run/fal-ai/sam-3/3d-objects` (queue-based, NOT `fal.run`)
- Auth header: `Authorization: Key ${FAL_KEY}` ✓
- Submit returns `{ request_id, status_url, response_url }` immediately — async only, no sync mode
- Must poll `GET ${status_url}` until status is `COMPLETED`, then `GET ${response_url}` for the result
- Output: `{ gaussian_splat: { url }, model_glb: { url }, per_object_metadata: [...] }`
- Output GLB key is `model_glb.url`, NOT `model_url`

**Our bugs:**
1. **CRITICAL**: We hit `fal.run/${model}` synchronously. Real endpoint requires queue submit + poll. → likely returns immediately with a 202 response we mis-parse
2. We look for `model_url`, `glb_url`, `output_url`, `url` — but actual output is nested at `model_glb.url`. → `pickUrl` would throw

## 5. HY-World 2.0 — UNVERIFIABLE BUT BROAD

HuggingFace hosts the model card, but there's no canonical hosted REST API. Users self-host.

**Real picture:**
- It's a Python library (`pip install hyworld` or clone the repo)
- No official endpoint contract — what `HYWORLD_ENDPOINT` returns is whatever the user's wrapper script returns
- Our code's `{prompt, image_url, video_url, panorama_url, detail, seed}` request shape and `{spz_url, ply_url, glb_url, thumb_url}` response shape are reasonable defaults but not authoritative

**Our bugs:**
- None we can verify. The contract is "self-hosted, you implement it." This is fine — but we should clearly document the expected request/response shape in a `HYWORLD-PROTOCOL.md` so users who self-host know what wrapper to write.

**Recommendation:** Mark this backend as "user-defined protocol" and ship a reference Python adapter that wraps the official HY-World inference pipeline into the shape our backend expects. Defer that to a later phase.

## Summary

| Backend     | Bugs | Severity | Live-test cost to discover |
|-------------|------|----------|----------------------------|
| TRELLIS-2   | 4    | Critical | $0 (would fail before billing) |
| Hunyuan3D   | 3    | Critical | $0 (default model 404s) |
| Tripo       | 2    | Critical | $0 (path 404s) |
| fal sam-3d  | 2    | Critical | $0 (queue, not sync) |
| HY-World    | 0    | n/a      | Self-hosted contract |

All four hosted-API backends were broken. Now fixing.
