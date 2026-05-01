# praetor world-gen backend audit & fix delivery

Phase C of the world-gen integration. After live-testing the World Labs backend
revealed it had been built against a guessed spec, all four hosted backends were
audited against current vendor docs (May 2026). All four were broken.

This branch fixes:

- `trellis2.ts` — Replicate input was `image: string`, real spec is `images: [url]`. `generate_model: true` was missing (no GLB without it). Auth header changed to `Bearer`.
- `tripo.ts`    — Path was `/task/text_to_model` (404). Real path is `/task` with `type` discriminator in body. Model version bumped to `v2.5`.
- `fal.ts`      — Hit sync `fal.run/{model}` (always wrong). Real API is queue-based: submit -> poll status -> fetch response. Output GLB is at `model_glb.url`, not `model_url`.
- `hunyuan3d.ts` — Replicate `tencent/hunyuan3d-2` is community README without working version pin. Switched hosted path to `fal-ai/hunyuan3d-v3/image-to-3d` (queue protocol).

`hyworld.ts` is unchanged — it's a user-defined protocol (no canonical hosted API). A protocol contract has been documented in `docs/hyworld-protocol.md`.

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
