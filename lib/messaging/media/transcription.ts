/**
 * Transcrição de áudio plugável (Onda 3). Default: API speech-to-text
 * OpenAI-compatível (Whisper) via BYOK. O derivado é texto → alimenta QUALQUER
 * modelo de chat (camada universal). Um backend mlx-whisper local implementa a
 * mesma interface para self-host em Apple Silicon (fora deste MVP).
 */
export interface TranscriptionProvider {
  transcribe(audio: Buffer, mime: string): Promise<string>;
}

export interface TranscriptionCreds {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

const DEFAULT_BASE = "https://api.openai.com";
const DEFAULT_MODEL = "whisper-1";

function extFor(mime: string): string {
  const base = mime.split(";")[0]!.trim().toLowerCase();
  if (base.includes("ogg")) return "ogg";
  if (base.includes("mpeg") || base.includes("mp3")) return "mp3";
  if (base.includes("mp4") || base.includes("m4a")) return "m4a";
  if (base.includes("webm")) return "webm";
  if (base.includes("wav")) return "wav";
  return "bin";
}

export function apiTranscriptionProvider(
  creds: TranscriptionCreds,
  fetchImpl: typeof fetch = fetch,
): TranscriptionProvider {
  const base = creds.baseUrl ?? DEFAULT_BASE;
  // Seleção pelo destino oficial, sem alterar backends OpenAI-compatíveis.
  const sarvam = base.trim().replace(/\/+$/, "") === "https://api.sarvam.ai";
  const model = creds.model ?? (sarvam ? "saaras:v3" : DEFAULT_MODEL);
  return {
    async transcribe(audio, mime) {
      const form = new FormData();
      form.append("model", model);
      if (sarvam) {
        form.append("language_code", "unknown");
        form.append("mode", "transcribe");
      }
      form.append(
        "file",
        new Blob([new Uint8Array(audio)], { type: mime.split(";")[0]!.trim() }),
        `audio.${extFor(mime)}`,
      );
      const res = await fetchImpl(
        sarvam ? "https://api.sarvam.ai/speech-to-text" : `${base}/v1/audio/transcriptions`,
        {
          method: "POST",
          headers: sarvam
            ? { "api-subscription-key": creds.apiKey }
            : { Authorization: `Bearer ${creds.apiKey}` },
          body: form,
        },
      );
      if (!res.ok) throw new Error(`transcription_${res.status}`);
      if (sarvam) {
        let result: unknown;
        try {
          result = await res.json();
        } catch {
          throw new Error("transcription_invalid_response");
        }
        if (
          !result ||
          typeof result !== "object" ||
          !("transcript" in result) ||
          typeof result.transcript !== "string" ||
          !result.transcript.trim()
        )
          throw new Error("transcription_invalid_response");
        return result.transcript;
      }
      const json = (await res.json()) as { text?: string };
      return json.text ?? "";
    },
  };
}
