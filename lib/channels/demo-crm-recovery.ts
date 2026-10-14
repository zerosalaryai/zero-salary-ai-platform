import { DEMO_WEB_CHANNEL, DemoWebDenied, readDemoWebConfig } from "./demo-web-ingress";

/** Separate opt-in; the established read-only deployment remains unchanged until enabled. */
export function demoCrmRecovery(source: Record<string, unknown> = process.env): boolean {
  const mode = source.DEMO_CRM_OPERATIONAL;
  if (mode === undefined || mode === "" || mode === "false") return false;
  if (mode !== "true") throw new DemoWebDenied();
  if (source.DEMO_WEB_INGRESS_ONLY === "true") return readDemoWebConfig(source);
  if (source.DEMO_INBOUND_ONLY === "true" && source.DEMO_CHANNEL_ID === DEMO_WEB_CHANNEL && source.ZSAI_AGENT_RUNTIME === "python" &&
      (source.DEMO_WEB_INGRESS_ONLY === undefined || source.DEMO_WEB_INGRESS_ONLY === "false" || source.DEMO_WEB_INGRESS_ONLY === "")) return true;
  throw new DemoWebDenied();
}
