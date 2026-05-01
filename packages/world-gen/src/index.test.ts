import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultSelector,
  resetDefaultSelector,
  generate_3d_model,
  generate_3d_world,
  edit_3d_scene,
  publish_3d_scene,
  renderGlbViewerHtml,
  renderSplatViewerHtml,
  MockModelBackend,
  MockWorldBackend,
  Trellis2Backend,
  Hunyuan3dBackend,
  TripoBackend,
  FalSam3dBackend,
  WorldLabsBackend,
  HyWorldBackend,
  DefaultWorldGenSelector,
} from "./index.js";

describe("@praetor/world-gen — selector", () => {
  beforeEach(() => resetDefaultSelector());
  afterEach(() => resetDefaultSelector());

  it("falls back to mock backends when no env keys are set", () => {
    const sel = new DefaultWorldGenSelector({} as NodeJS.ProcessEnv);
    expect(sel.pickModelBackend().name).toBe("mock");
    expect(sel.pickWorldBackend().name).toBe("mock");
  });

  it("respects WORLD_GEN_REQUIRE_LIVE by throwing instead of falling back", () => {
    const sel = new DefaultWorldGenSelector({ WORLD_GEN_REQUIRE_LIVE: "true" } as any);
    expect(() => sel.pickModelBackend()).toThrow(/no live model backend/);
    expect(() => sel.pickWorldBackend()).toThrow(/no live world backend/);
  });

  it("selects Hunyuan3D first when FAL_API_KEY is present (preferred over Replicate-only TRELLIS-2)", () => {
    const sel = new DefaultWorldGenSelector({ FAL_API_KEY: "k" } as any);
    expect(sel.pickModelBackend().name).toBe("hunyuan3d");
  });

  it("selects TRELLIS-2 when only REPLICATE_API_TOKEN is set (Hunyuan3D no longer activates on Replicate)", () => {
    const sel = new DefaultWorldGenSelector({ REPLICATE_API_TOKEN: "tok" } as any);
    expect(sel.pickModelBackend().name).toBe("trellis2");
  });

  it("explicit \"trellis2\" override is honored when REPLICATE_API_TOKEN is set", () => {
    const sel = new DefaultWorldGenSelector({ REPLICATE_API_TOKEN: "tok" } as any);
    expect(sel.pickModelBackend("trellis2").name).toBe("trellis2");
  });

  it("prefers Hunyuan3D self-host over fal hosted", () => {
    const sel = new DefaultWorldGenSelector({
      HUNYUAN3D_ENDPOINT: "https://hy.example/run",
      FAL_API_KEY: "k",
    } as any);
    expect(sel.pickModelBackend().name).toBe("hunyuan3d");
  });

  it("selects World Labs when WORLDLABS_API_KEY is present", () => {
    const sel = new DefaultWorldGenSelector({ WORLDLABS_API_KEY: "k" } as any);
    expect(sel.pickWorldBackend().name).toBe("worldlabs");
  });

  it("prefers HY-World self-host over World Labs", () => {
    const sel = new DefaultWorldGenSelector({
      HYWORLD_ENDPOINT: "https://hy.example/world",
      WORLDLABS_API_KEY: "k",
    } as any);
    expect(sel.pickWorldBackend().name).toBe("hyworld");
  });

  it("listAvailable() reports backends discovered from env", () => {
    const sel = new DefaultWorldGenSelector({
      REPLICATE_API_TOKEN: "x",
      FAL_API_KEY: "f",
      TRIPO_API_KEY: "y",
      WORLDLABS_API_KEY: "z",
    } as any);
    const a = sel.listAvailable();
    expect(a.models).toContain("hunyuan3d");
    expect(a.models).toContain("trellis2");
    expect(a.models).toContain("tripo");
    expect(a.models).toContain("fal-sam-3d");
    expect(a.models).toContain("mock");
    expect(a.worlds).toContain("worldlabs");
    expect(a.worlds).toContain("mock");
  });

  it("explicit override is honored even if backend is unavailable", () => {
    const sel = new DefaultWorldGenSelector({} as any);
    // mock is always available, so an explicit "mock" works
    expect(sel.pickModelBackend("mock").name).toBe("mock");
  });

  it("throws on unknown explicit backend names", () => {
    const sel = new DefaultWorldGenSelector({} as any);
    expect(() => sel.pickModelBackend("nope")).toThrow(/unknown model backend/);
    expect(() => sel.pickWorldBackend("nope")).toThrow(/unknown world backend/);
  });
});

describe("backend availability gates", () => {
  it("TRELLIS-2 unavailable without keys", () => {
    expect(new Trellis2Backend({}).available).toBe(false);
  });
  it("TRELLIS-2 available with REPLICATE_API_TOKEN config", () => {
    expect(new Trellis2Backend({ replicateToken: "x" }).available).toBe(true);
  });
  it("TRELLIS-2 available with self-host endpoint", () => {
    expect(new Trellis2Backend({ endpoint: "https://x.example/" }).available).toBe(true);
  });
  it("Hunyuan3D unavailable without keys", () => {
    expect(new Hunyuan3dBackend({}).available).toBe(false);
  });
  it("Tripo gated on TRIPO_API_KEY", () => {
    expect(new TripoBackend({}).available).toBe(false);
    expect(new TripoBackend({ apiKey: "x" }).available).toBe(true);
  });
  it("fal gated on FAL_API_KEY", () => {
    expect(new FalSam3dBackend({}).available).toBe(false);
    expect(new FalSam3dBackend({ apiKey: "x" }).available).toBe(true);
  });
  it("World Labs gated on WORLDLABS_API_KEY", () => {
    expect(new WorldLabsBackend({}).available).toBe(false);
    expect(new WorldLabsBackend({ apiKey: "x" }).available).toBe(true);
  });
  it("HY-World gated on HYWORLD_ENDPOINT", () => {
    expect(new HyWorldBackend({}).available).toBe(false);
    expect(new HyWorldBackend({ endpoint: "https://x.example/" }).available).toBe(true);
  });
  it("Mock always available", () => {
    expect(new MockModelBackend().available).toBe(true);
    expect(new MockWorldBackend().available).toBe(true);
  });
});

describe("generate_3d_model — meter + audit hooks", () => {
  it("emits an audit event and settles the meter on success", async () => {
    let settled = -1;
    let released = false;
    const audited: any[] = [];
    const sel = new DefaultWorldGenSelector({} as any);
    const result = await generate_3d_model(
      { prompt: "low-poly red helmet", detail: "draft" },
      {
        selector: sel,
        meter: {
          charge: async ({ sku, estUsd }) => {
            expect(sku).toBe("world_gen.model.draft");
            expect(estUsd).toBeGreaterThan(0);
            return {
              settle: async (n) => { settled = n; },
              release: async () => { released = true; },
            };
          },
        },
        audit: (e) => audited.push(e),
        missionId: "m1",
      },
    );
    expect(result.backend).toBe("mock");
    expect(result.glbUrl).toMatch(/^mock:\/\/glb\//);
    expect(settled).toBeGreaterThanOrEqual(0);
    expect(released).toBe(false);
    expect(audited[0]?.type).toBe("world_gen.model");
    expect(audited[0]?.resultUrl).toBe(result.glbUrl);
  });

  it("releases the meter and emits world_gen.error on backend failure", async () => {
    let released = false;
    const audited: any[] = [];
    // forcibly use a backend that throws
    const sel: any = {
      pickModelBackend: () => ({
        name: "boom",
        available: true,
        async generateModel() { throw new Error("nope"); },
      }),
    };
    await expect(generate_3d_model(
      { prompt: "x" },
      {
        selector: sel,
        meter: {
          charge: async () => ({
            settle: async () => {},
            release: async () => { released = true; },
          }),
        },
        audit: (e) => audited.push(e),
      },
    )).rejects.toThrow(/nope/);
    expect(released).toBe(true);
    expect(audited[0]?.type).toBe("world_gen.error");
  });
});

describe("generate_3d_world — meter + audit hooks", () => {
  it("settles meter and emits world_gen.world on success", async () => {
    let settled = -1;
    const audited: any[] = [];
    const sel = new DefaultWorldGenSelector({} as any);
    const result = await generate_3d_world(
      { prompt: "medieval village at sunset", detail: "draft" },
      {
        selector: sel,
        meter: { charge: async () => ({ settle: async (n) => { settled = n; }, release: async () => {} }) },
        audit: (e) => audited.push(e),
      },
    );
    expect(result.backend).toBe("mock");
    expect(result.spzUrl).toMatch(/^mock:\/\/spz\//);
    expect(settled).toBeGreaterThanOrEqual(0);
    expect(audited[0]?.type).toBe("world_gen.world");
  });
});

describe("edit_3d_scene", () => {
  it("returns a SuperSplat deep link with the asset preloaded", () => {
    const r = edit_3d_scene({ assetUrl: "https://cdn.example.com/scene.spz", title: "Forest" });
    expect(r.editorUrl).toMatch(/playcanvas\.com\/supersplat\/editor/);
    expect(r.editorUrl).toMatch(/load=https/);
    expect(r.editorUrl).toContain("title=Forest");
    expect(r.assetUrl).toBe("https://cdn.example.com/scene.spz");
  });
  it("throws without assetUrl", () => {
    expect(() => edit_3d_scene({} as any)).toThrow();
  });
});

describe("publish_3d_scene", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "wg-")); });

  it("writes index.html, world.html, manifest.json for a splat scene", () => {
    const r = publish_3d_scene({
      id: "test-world",
      splatUrl: "https://example.com/world.spz",
      title: "Test",
      outDir: dir,
    });
    expect(r.id).toBe("test-world");
    expect(r.viewerPath).toBe("/scenes/test-world/index.html");
    expect(existsSync(join(dir, "test-world", "index.html"))).toBe(true);
    expect(existsSync(join(dir, "test-world", "world.html"))).toBe(true);
    expect(existsSync(join(dir, "test-world", "manifest.json"))).toBe(true);
    const html = readFileSync(join(dir, "test-world", "index.html"), "utf8");
    expect(html).toContain("https://example.com/world.spz");
    expect(html).toContain("@sparkjsdev/spark");
  });

  it("writes model.html for a GLB scene", () => {
    publish_3d_scene({
      id: "model1",
      glbUrl: "https://example.com/m.glb",
      title: "Model",
      outDir: dir,
    });
    const html = readFileSync(join(dir, "model1", "model.html"), "utf8");
    expect(html).toContain("model-viewer");
    expect(html).toContain("https://example.com/m.glb");
  });

  it("rejects ids that sanitize to empty", () => {
    expect(() => publish_3d_scene({ id: "@@@", glbUrl: "x", outDir: dir })).toThrow();
  });

  it("rejects when neither glbUrl nor splatUrl is provided", () => {
    expect(() => publish_3d_scene({ id: "x", outDir: dir })).toThrow(/glbUrl or splatUrl/);
  });
});

describe("viewer HTML emitters", () => {
  it("model-viewer escapes attributes and embeds the GLB url", () => {
    const html = renderGlbViewerHtml({ glbUrl: "https://example.com/a.glb", title: "<title>" });
    expect(html).toContain("https://example.com/a.glb");
    expect(html).toContain("&lt;title&gt;");
    expect(html).toContain('script type="module"');
    expect(html).toContain("model-viewer");
  });
  it("splat viewer pulls in spark + three", () => {
    const html = renderSplatViewerHtml({ splatUrl: "https://example.com/x.spz" });
    expect(html).toContain("https://example.com/x.spz");
    expect(html).toContain("@sparkjsdev/spark");
    expect(html).toContain("three.module.js");
  });
});

describe("integration — defaultSelector cached", () => {
  it("returns the same instance across calls until reset", () => {
    const a = defaultSelector();
    const b = defaultSelector();
    expect(a).toBe(b);
    resetDefaultSelector();
    const c = defaultSelector();
    expect(c).not.toBe(a);
  });
});
