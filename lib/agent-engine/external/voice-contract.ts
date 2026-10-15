import { z } from "zod";

export const voiceReplySchema = z.strictObject({
  inboundMessageId: z.uuid(),
  language: z.enum(["ml", "en"]),
});
export type VoiceReply = z.infer<typeof voiceReplySchema>;
export function reservedVoiceDelivery(voice: VoiceReply) {
  return { state: "reserved" as const, voice: voiceReplySchema.parse(voice) };
}
