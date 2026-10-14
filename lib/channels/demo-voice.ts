import "server-only";
import { getAdapter } from "@/lib/channels";
import { apiTranscriptionProvider } from "@/lib/messaging/media/transcription";
import { motivoDaRecusaDeDestino } from "@/lib/automation/destinos-internos-autorizados";

/** Signed ingress binding is established before this function is called. */
export async function transcribeDemoVoice(org: string, phoneId: string, media: { id: string; mime?: string | null }): Promise<{ text: string; buffer: Buffer; mime: string }> {
  const key = process.env.TRANSCRIPTION_API_KEY || process.env.OPENAI_API_KEY;
  const baseUrl = process.env.TRANSCRIPTION_BASE_URL;
  if (!key || !/^[0-9]+$/.test(phoneId) || !/^[A-Za-z0-9._~-]+$/.test(media.id)) throw new Error("demo_voice_not_configured");
  if (baseUrl && await motivoDaRecusaDeDestino(baseUrl, "instalacao")) throw new Error("demo_voice_destination_denied");
  const adapter = getAdapter("meta_cloud");
  if (!adapter.fetchInboundMedia) throw new Error("demo_voice_unavailable");
  const fetched = await adapter.fetchInboundMedia({ organizationId: org, sessionRef: phoneId, url: `meta-media:${media.id}`, hintMime: media.mime ?? null });
  if (!fetched.mime.startsWith("audio/") || fetched.buffer.byteLength > 16 * 1024 * 1024) throw new Error("demo_voice_media_denied");
  const text = (await apiTranscriptionProvider({ apiKey: key, baseUrl, model: process.env.TRANSCRIPTION_MODEL }, (url, init) => fetch(url, {...init, signal: AbortSignal.timeout(45_000)})).transcribe(fetched.buffer, fetched.mime)).trim();
  if (!text || text.length > 4000) throw new Error("demo_voice_transcription_failed");
  return { text, ...fetched };
}
