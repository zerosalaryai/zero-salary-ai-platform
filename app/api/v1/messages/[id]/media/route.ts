// app/api/v1/messages/[id]/media/route.ts
/**
 * GET /api/v1/messages/[id]/media — acesso autenticado à mídia da mensagem.
 * Persistida → 302 pra signed URL (TTL 1h) do bucket whatsapp-media.
 * Ainda não persistida (janela até o worker rodar) → proxy dos bytes do WAHA.
 * A URL desta rota é usada diretamente como src de <img>/<video>/<audio>
 * (cookie de sessão vai junto por ser same-origin; RLS decide o acesso).
 */
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import {
  CHANNEL_SESSION_REF_COLUMNS,
  DEFAULT_CHANNEL_PROVIDER,
  getAdapter,
  resolveSessionRef,
  type ChannelProvider,
  type ChannelSessionRef,
} from "@/lib/channels";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";
import { ApiError } from "@/lib/api/types";
import { demoInboxReadChannel } from "@/lib/channels/demo-inbox-read";
import { readDemoWebConfig } from "@/lib/channels/demo-web-ingress";
import { storagePathFor } from "@/lib/messaging/media/types";

export const dynamic = "force-dynamic";

const SIGNED_URL_TTL_S = 3600;

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id: messageId } = await ctx.params;
  const supabase = await createClient();

  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }
  const authUser = await loadAuthUser();
  const t = (texto: string) => traduzir(texto, authUser?.idioma ?? "pt-BR");
  const activeOrg = authUser ? await resolveActiveOrg(authUser) : null;
  if (!activeOrg) {
    return fail("no_active_org", t("No active organization."), 403, { requestId });
  }

  if (readDemoWebConfig()) {
    try {
      if (!z.uuid().safeParse(messageId).success || authUser?.support || authUser?.id !== user.id)
        return fail("forbidden", "Media access denied.", 403, { requestId });
      const channel = await demoInboxReadChannel(supabase, {
        organization_id: activeOrg.orgId, actor: { type: "user", id: user.id }, requestId,
      });
      if (!channel) return fail("forbidden", "Media access denied.", 403, { requestId });
      const { data: message, error: messageError } = await supabase.from("messages")
        .select("id, conversation_id, contact_id, media_storage_path, media_mime, media_size_bytes, revoked_at")
        .eq("id", messageId).eq("organization_id", activeOrg.orgId)
        .eq("channel_session_id", channel).maybeSingle();
      if (messageError) return fail("internal_error", "Media lookup failed.", 500, { requestId });
      if (!message || message.revoked_at || !message.media_storage_path ||
          !z.uuid().safeParse(message.conversation_id).success || !z.uuid().safeParse(message.contact_id).success)
        return fail("not_found", "Stored media unavailable.", 404, { requestId });
      const { data: conversation, error: conversationError } = await supabase.from("conversations")
        .select("id").eq("id", message.conversation_id).eq("contact_id", message.contact_id)
        .eq("organization_id", activeOrg.orgId).eq("channel_session_id", channel).maybeSingle();
      const { data: contact, error: contactError } = await supabase.from("contacts")
        .select("id").eq("id", message.contact_id).eq("organization_id", activeOrg.orgId).maybeSingle();
      if (conversationError || contactError)
        return fail("internal_error", "Media lookup failed.", 500, { requestId });
      const mime = message.media_mime?.split(";")[0]?.trim().toLowerCase();
      // Never fetch transport URLs or sign arbitrary stored paths in demo mode.
      // Bound memory usage and prohibit active document types from rendering inline.
      const inline = /^(image\/(jpeg|png|gif|webp)|audio\/(ogg|mpeg|mp4|wav|webm)|video\/(mp4|webm))$/;
      if (!conversation || !contact || !mime ||
          message.media_storage_path !== storagePathFor(activeOrg.orgId, message.conversation_id, messageId, mime) ||
          !Number.isFinite(message.media_size_bytes) || message.media_size_bytes! <= 0 || message.media_size_bytes! > 25 * 1024 * 1024)
        return fail("not_found", "Stored media unavailable.", 404, { requestId });
      // The private bucket permits service-role reads only (0055). All identity
      // and canonical-path checks above use the session client before this read.
      // Return authorized bytes only; never expose credentials or a signed URL.
      const { data: blob, error: downloadError } = await createAdminClient().storage
        .from("whatsapp-media").download(message.media_storage_path);
      if (downloadError || !blob || blob.size !== message.media_size_bytes)
        return fail("not_found", "Stored media unavailable.", 404, { requestId });
      return new Response(blob, { headers: {
        "Content-Type": inline.test(mime) ? mime : "application/octet-stream",
        "Content-Disposition": inline.test(mime) ? "inline" : "attachment",
        "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "X-Request-Id": requestId,
      } });
    } catch (err) {
      if (err instanceof ApiError) return fail(err.code, err.message, err.status, { requestId });
      return fail("forbidden", "Media access denied.", 403, { requestId });
    }
  }

  // Client de sessão: RLS garante que a mensagem pertence a uma org do usuário.
  // Filtro explícito de organization_id por doutrina (defense-in-depth).
  const { data: msg, error } = await supabase
    .from("messages")
    .select("id, media_url, media_mime, media_storage_path, channel_session_id")
    .eq("id", messageId)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (error) {
    return fail("internal_error", t("Erro ao buscar mensagem."), 500, { requestId });
  }
  if (!msg || (!msg.media_storage_path && !msg.media_url)) {
    return fail("not_found", t("Mensagem sem mídia."), 404, { requestId });
  }

  if (msg.media_storage_path) {
    const admin = createAdminClient();
    const { data: signed, error: signErr } = await admin.storage
      .from("whatsapp-media")
      .createSignedUrl(msg.media_storage_path, SIGNED_URL_TTL_S);
    if (!signErr && signed?.signedUrl) {
      const response = NextResponse.redirect(signed.signedUrl, 302);
      response.headers.set("X-Request-Id", requestId);
      return response;
    }
    if (signErr) {
      console.error("[messages.media] createSignedUrl failed", signErr.message);
    }
  }

  // ── Fallback: o worker ainda não persistiu ──────────────────────────────────
  //
  // O drain é cron de minuto a minuto, então esta janela é diária: quem abre a
  // conversa antes da persistência cai aqui. O browser não alcança o transporte
  // nem tem a credencial, por isso o proxy é server-side.
  //
  // Pelo ADAPTER, não por uma função fixa. Esta era literalmente a linha que o
  // conserto do worker removeu de lá e esqueceu aqui: com `fetchWahaMedia` em
  // duro, o path de um anexo do canal intermediado era procurado dentro do
  // contêiner do canal por QR — 404, e a tela dizia "mídia indisponível".
  if (msg.media_url) {
    try {
      const admin = createAdminClient();
      const { data: sessao } = await admin
        .from("channel_sessions")
        .select(`provider, ${CHANNEL_SESSION_REF_COLUMNS}`)
        .eq("organization_id", activeOrg.orgId)
        .eq("id", msg.channel_session_id)
        .maybeSingle();

      const adapter = getAdapter(
        ((sessao?.provider as string) ?? DEFAULT_CHANNEL_PROVIDER) as ChannelProvider,
      );
      const sessionRef = sessao ? resolveSessionRef(sessao as unknown as ChannelSessionRef) : null;
      if (!adapter.fetchInboundMedia || !sessionRef) {
        // Canal sem mídia de entrada não é defeito: é estado normal. 404 diz a
        // verdade ("não há o que servir"); 502 acusaria uma falha inexistente.
        return fail("not_found", t("Mensagem sem mídia."), 404, { requestId });
      }

      const media = await adapter.fetchInboundMedia({
        organizationId: activeOrg.orgId,
        sessionRef,
        url: msg.media_url,
        hintMime: msg.media_mime,
      });
      return new Response(new Uint8Array(media.buffer), {
        status: 200,
        headers: {
          "Content-Type": media.mime,
          "Cache-Control": "private, max-age=60",
          "X-Request-Id": requestId,
        },
      });
    } catch {
      return fail("bad_gateway", t("Mídia indisponível no momento."), 502, { requestId });
    }
  }

  return fail("not_found", t("Mensagem sem mídia."), 404, { requestId });
}
