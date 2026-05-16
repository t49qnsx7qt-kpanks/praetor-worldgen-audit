# praetor world-gen backend audit & fix delivery

Phase C of the world-gen integration. Audit pass against current vendor docs
(May 2026) plus fixes for the four hosted backends.

This branch fixes:

- `trellis2.ts` — Replicate input updated to `images: [url]` and `generate_model: true` (required for GLB output). Auth header switched to `Bearer`.
- `tripo.ts`    — Path updated to `/task` with `type` discriminator in body. Model version bumped to `v2.5`.
- `fal.ts`      — Switched from sync `fal.run/{model}` to the queue-based API: submit -> poll status -> fetch response. Output GLB resolved from `model_glb.url`.
- `hunyuan3d.ts` — Switched hosted path to `fal-ai/hunyuan3d-v3/image-to-3d` (queue protocol) since the Replicate `tencent/hunyuan3d-2` listing has no pinned working version.

`hyworld.ts` is unchanged — it's a user-defined protocol (no canonical hosted API). A protocol contract has been documented in `docs/hyworld-protocol.md`.

> Legacy Praetor delivery drop. Archived; primitives now ship in @mnemopay/sdk.

## Apply

From your `praetor` repo root:

```
git remote add wgaudit https://github.com/t49qnsx7qt-kpanks/praetor-worldgen-audit.git
git fetch wgaudit
git checkout master
git checkout wgaudit/master -- packages/world-gen/src/backends/trellis2.ts
git checkout wgaudit/master -- packages/world-gen/src/backends/tripo.ts
git checkout wgaudit/master -- packages/world-gen/src/backends/fal.ts
git checkout wgaudit/master -- packages/world-gen/src/backends/hunyuan3d.ts
git checkout wgaudit/master -- docs/world-gen-backend-audit.md
git checkout wgaudit/master -- docs/hyworld-protocol.md
git remote remove wgaudit
```

Then:

```
npm run --workspace=@praetor/world-gen build
npx vitest run --root packages/world-gen
```

The selector test that asserted "Hunyuan3D activates on REPLICATE_API_TOKEN alone" needs to be updated — Hunyuan3D's hosted path now requires `FAL_API_KEY`. See `docs/world-gen-backend-audit.md` for details.
