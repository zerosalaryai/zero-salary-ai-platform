# Voice replies through the canonical CRM sender

Local implementation; not enabled or deployed. No second WhatsApp sender.

`messages` (trusted inbound type/channel) → `resolveVoiceReply` → Python text
generation → existing `runBeforeSend` → `sendTurnMessage` → reserved `send_ledger`
→ HMAC `/internal/speech` → private `whatsapp-media` OGG/Opus → canonical
`sendMessageHandler` → channel adapter → CRM message/receipt → accepted checkpoint
and existing lead capture. Meta's existing adapter sets `audio.voice=true`.

## Configuration and modality

Each channel independently opts in with server-owned
`channel_sessions.metadata.voice_reply_mode="match_input"`. Absent or `"text"`
preserves existing text behavior. Text inbound stays text. Audio inbound requests
one voice reply; it is never split into several messages or silently downgraded to
text on synthesis failure. Current speech supports English and Malayalam/mixed
Malayalam-English; other languages fail explicitly. No channel metadata was changed.

The Worker reuses its Python runtime HTTPS origin and HMAC pair. Python needs the
Phase 1 `/internal/speech`, `MURF_API_KEY`, approved server-owned
`ZSAI_MURF_VOICE_ML` / `ZSAI_MURF_VOICE_EN`, and ffmpeg with libopus (the existing
Railpack configuration includes ffmpeg). Provider output is bounded PCM WAV 24 kHz;
conversion produces bounded mono OGG/Opus, `audio/ogg;codecs=opus`. No credentials
or public audio URLs are persisted in the ledger. The approved transcript remains
in CRM, and Inbox uses its existing authorized media endpoint/player.

Demo safety remains layered: `DEMO_INBOUND_ONLY` and exact channel boot binding,
existing freshness/STOP/handoff/service-boundary checks, then an additional
default-off `DEMO_VOICE_REPLY_CHANNEL_ID` equal to the full verified 0230 UUID.
That variable alone grants nothing: both handler and transport also require the
canonical, server-side prepared-voice capability for the current validated job.
No Web process can send. Other channels, including 7270, gain no demo permissions.
No runtime variable was set and no sender was activated.

## Durable delivery and uncertainty

Local additive migration **0345** adds nullable `send_ledger.voice_delivery`;
existing text intents retain their semantics. New voice state is monotone:
`reserved → preparing → ready → attempted`. Compare-and-set updates include org,
intent, current job claim and channel policy. A single winner prepares speech.
The trigger freezes tenant/contact/job/sequence/body/checkpoint, binds the audio
source through tenant-aware durable joins, and prevents browser roles from
creating, changing or deleting voice delivery state. It grants no new table access.

Ready retries reuse the same stored descriptor and verify private bytes against
its SHA-256. They reuse the frozen V2 candidate through the same final guardrails;
they do not regenerate a different AI reply/checkpoint. The attempt fence commits
before calling the canonical handler. A CRM `sent/delivered/read` receipt with a
nonempty provider ID can reconcile the intent and finish checkpoint persistence.

A crash during preparation, a lost commit acknowledgement, a queued/failed
handler result after the fence, or a missing provider receipt **holds** the intent.
No automatic rotation, lease stealing, alternate sender or blind resend occurs.
Existing worker errors/CRM delivery status expose the failure; operator receipt
reconciliation is required. This trades availability for duplicate safety and
does not claim exactly-once delivery across PostgreSQL, Storage and Meta HTTP.

## Controlled verification prerequisites

Paused 0344 remains unchanged. Neither 0344 nor 0345 was executed by this work.
Before enabling the 0230-only voice test, separately rehearse 0345 trigger/ACL/CAS
behavior on disposable PostgreSQL, review/publish the exact CRM and Python source,
apply approved schema prerequisites, verify deployed `/internal/speech` parity,
Murf voice identities, private Storage access and ffmpeg/libopus availability.
Then obtain explicit deployment/configuration approval and test one authorized
0230 voice note, confirming one provider ID, one playable CRM audio message and
the accepted checkpoint. No live or browser validation is implied by mocked tests.
