import { describe, expect, it, vi } from "vitest";
import { apiTranscriptionProvider } from "@/lib/messaging/media/transcription";

const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
describe("Sarvam REST transcription", () => {
  it.each(["എനിക്ക് ഒരു ഡെമോ വേണം", "I need a sales demo"])(
    "preserves detected language: %s",
    async (transcript) => {
      const fetchMock = vi.fn().mockResolvedValue(response({ transcript }));
      const provider = apiTranscriptionProvider(
        { apiKey: "synthetic-key", baseUrl: "https://api.sarvam.ai/" },
        fetchMock,
      );
      expect(await provider.transcribe(Buffer.from([1, 2]), "audio/ogg; codecs=opus")).toBe(
        transcript,
      );
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("https://api.sarvam.ai/speech-to-text");
      expect(init.headers).toEqual({ "api-subscription-key": "synthetic-key" });
      const form = init.body as FormData;
      expect(form.get("model")).toBe("saaras:v3");
      expect(form.get("language_code")).toBe("unknown");
      expect(form.get("mode")).toBe("transcribe");
      const file = form.get("file") as File;
      expect(file.name).toBe("audio.ogg");
      expect(file.type).toBe("audio/ogg");
      expect(file.size).toBe(2);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );
  it.each([null, {}, { text: "wrong contract" }, { transcript: 123 }, { transcript: "  " }])(
    "rejects malformed successful responses: %j",
    async (body) => {
      const provider = apiTranscriptionProvider(
        { apiKey: "synthetic", baseUrl: "https://api.sarvam.ai" },
        vi.fn().mockResolvedValue(response(body)),
      );
      await expect(provider.transcribe(Buffer.from([1]), "audio/ogg")).rejects.toThrow(
        "transcription_invalid_response",
      );
    },
  );
  it("rejects invalid JSON", async () => {
    const provider = apiTranscriptionProvider(
      { apiKey: "synthetic", baseUrl: "https://api.sarvam.ai" },
      vi.fn().mockResolvedValue(new Response("not JSON")),
    );
    await expect(provider.transcribe(Buffer.from([1]), "audio/ogg")).rejects.toThrow(
      "transcription_invalid_response",
    );
  });
  it("propagates HTTP failure without response contents or retry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("private provider detail", { status: 429 }));
    const provider = apiTranscriptionProvider(
      { apiKey: "synthetic", baseUrl: "https://api.sarvam.ai" },
      fetchMock,
    );
    await expect(provider.transcribe(Buffer.from([1]), "audio/ogg")).rejects.toThrow(
      /^transcription_429$/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("preserves a custom OpenAI-compatible provider", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ text: "hello" }));
    const provider = apiTranscriptionProvider(
      { apiKey: "synthetic", baseUrl: "https://compatible.invalid", model: "custom-model" },
      fetchMock,
    );
    expect(await provider.transcribe(Buffer.from([1]), "audio/wav")).toBe("hello");
    expect(fetchMock.mock.calls[0]![0]).toBe("https://compatible.invalid/v1/audio/transcriptions");
    expect(fetchMock.mock.calls[0]![1].headers).toEqual({ Authorization: "Bearer synthetic" });
    expect((fetchMock.mock.calls[0]![1].body as FormData).get("language_code")).toBeNull();
  });
});
