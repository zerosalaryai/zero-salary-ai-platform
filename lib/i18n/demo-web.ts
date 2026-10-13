import "server-only";

import { DEMO_WEB_CHANNEL, readDemoWebConfig } from "@/lib/channels/demo-web-ingress";

/** Somente apresentação; não concede acesso a dados nem autoriza ações. */
export type DemoWebPresentation = Readonly<{
  channelId: typeof DEMO_WEB_CHANNEL;
  locale: "en-US";
}>;

/** Derivado apenas da configuração privada validada, nunca de input do browser. */
export function demoWebPresentation(): DemoWebPresentation | null {
  return readDemoWebConfig() ? { channelId: DEMO_WEB_CHANNEL, locale: "en-US" } : null;
}

/** A apresentação da demo não grava preferências nem muda o padrão dos tenants. */
export function idiomaDaDemoWeb(): "en-US" | null {
  return demoWebPresentation()?.locale ?? null;
}
