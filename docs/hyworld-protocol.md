# HY-World 2.0 — Self-Hosted Endpoint Protocol

`@praetor/world-gen`'s `HyWorldBackend` is intentionally protocol-only. Tencent's HY-World 2.0 ships as a Python library and a reference inference script — there's no canonical hosted REST API. Users who self-host stand up their own wrapper.

To plug a self-hosted instance into Praetor, expose a single endpoint that conforms to the contract below. Set `HYWORLD_ENDPOINT=https://your-host/api/world-gen` and (optionally) `HYWORLD_AUTH=Bearer your-token`.

## Request

```
POST {HYWORLD_ENDPOINT}
Content-Type: application/json
Authorization: {HYWORLD_AUTH}    (optional)

{
  "prompt":        "string",
  "image_url":     "string|null",
  "video_url":     "string|null",
  "panorama_url":  "string|null",
  "detail":        "draft" | "standard" | "high",
  "seed":          number | null
}
```

The wrapper picks the right HY-World 2.0 inference path based on which of `image_url`, `video_url`, `panorama_url` is set (else text-only).

## Response (synchronous)

```json
{
  "spz_url":   "https://...",   // primary 3D Gaussian splat archive
  "ply_url":   "https://...",   // optional raw splat
  "glb_url":   "https://...",   // optional mesh export
  "thumb_url": "https://..."    // optional preview / panorama
}
```

At least one of `spz_url`, `ply_url`, or `glb_url` must be present. Praetor will pick `spz_url` first for splat embeds, fall back to `glb_url` for `<model-viewer>`.

## Reference Python wrapper

A minimal FastAPI wrapper that adapts HY-World 2.0's pipeline lives in `packages/world-gen/contrib/hyworld-server/`. Run it on an H100/A100 box with 80GB+ VRAM and point Praetor at it.
