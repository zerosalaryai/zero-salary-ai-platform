import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ media: vi.fn(), destination: vi.fn() }));
vi.mock("@/lib/channels", () => ({ getAdapter: () => ({ fetchInboundMedia: mocks.media }) }));
vi.mock("@/lib/automation/destinos-internos-autorizados", () => ({
  motivoDaRecusaDeDestino: mocks.destination,
}));
import { transcribeDemoVoice } from "@/lib/channels/demo-voice";

describe("0230 voice caller with Sarvam", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("TRANSCRIPTION_API_KEY", "synthetic-key");
    vi.stubEnv("TRANSCRIPTION_BASE_URL", "https://api.sarvam.ai");
    vi.stubEnv("TRANSCRIPTION_MODEL", "saaras:v3");
    vi.stubEnv("OPENAI_API_KEY", "");
    mocks.destination.mockResolvedValue(null);
    mocks.media.mockResolvedValue({ buffer: Buffer.from([1, 2]), mime: "audio/ogg" });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  it("feeds real transcript text and original media to existing ingestion", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ transcript: "  എനിക്ക് ഡെമോ വേണം  " })));
    vi.stubGlobal("fetch", fetchMock);
    const result = await transcribeDemoVoice("synthetic-org", "1253578844501717", {
      id: "synthetic-media",
    });
    expect(result.text).toBe("എനിക്ക് ഡെമോ വേണം");
    expect(result.buffer).toEqual(Buffer.from([1, 2]));
    expect(mocks.media).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "synthetic-org",
        sessionRef: "1253578844501717",
        url: "meta-media:synthetic-media",
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
  });
  it("propagates provider failure without fabricating text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("denied", { status: 403 })));
    await expect(
      transcribeDemoVoice("synthetic-org", "1253578844501717", { id: "synthetic-media" }),
    ).rejects.toThrow("transcription_403");
  });
  it("refuses absent credentials before media access", async () => {
    vi.stubEnv("TRANSCRIPTION_API_KEY", "");
    await expect(
      transcribeDemoVoice("synthetic-org", "1253578844501717", { id: "synthetic-media" }),
    ).rejects.toThrow("demo_voice_not_configured");
    expect(mocks.media).not.toHaveBeenCalled();
  });
  it("rejects nonaudio before contacting STT", async () => {
    mocks.media.mockResolvedValue({ buffer: Buffer.from([1]), mime: "image/png" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      transcribeDemoVoice("synthetic-org", "1253578844501717", { id: "synthetic-media" }),
    ).rejects.toThrow("demo_voice_media_denied");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
