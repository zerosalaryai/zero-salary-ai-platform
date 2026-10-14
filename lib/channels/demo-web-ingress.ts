/** Política pura: pode ser importada pelo proxy, sem banco/Node APIs. */
export const DEMO_WEB_CHANNEL = "c67e9f8a-8719-4481-9154-ed8a464f85bd";
export class DemoWebDenied extends Error {
  constructor() {
    super("demo_web_ingress_denied");
    this.name = "DemoWebDenied";
  }
}
export function readDemoWebConfig(source: Record<string, unknown> = process.env): boolean {
  const mode = source.DEMO_WEB_INGRESS_ONLY;
  if (source.DEMO_CRM_OPERATIONAL === "true" && mode !== "true" &&
      !(source.DEMO_INBOUND_ONLY === "true" && source.DEMO_CHANNEL_ID === DEMO_WEB_CHANNEL)) throw new DemoWebDenied();
  if (mode === undefined || mode === "" || mode === "false") return false;
  if (
    ![undefined, "", "true", "false"].includes(source.DEMO_CRM_OPERATIONAL as string | undefined) ||
    mode !== "true" ||
    source.DEMO_WEB_CHANNEL_ID !== DEMO_WEB_CHANNEL ||
    (source.DEMO_INBOUND_ONLY !== undefined &&
      source.DEMO_INBOUND_ONLY !== "" &&
      source.DEMO_INBOUND_ONLY !== "false")
  )
    throw new DemoWebDenied();
  return true;
}
export function denyDemoWebAction(): void {
  if (readDemoWebConfig()) throw new DemoWebDenied();
}
/** GET APIs também podem mutar. Só páginas/assets e a porta explícita são permitidos. */
export function demoWebRequestAllowed(
  path: string,
  method: string,
  serverAction: boolean,
): boolean {
  if (!readDemoWebConfig()) return true;
  if (serverAction) return false;
  if (/^\/api\/v1\/webhooks\/meta\/[^/]+$/.test(path)) return method === "GET" || method === "POST";
  if (path === "/api/demo-web-auth") return method === "POST";
  if (process.env.DEMO_CRM_OPERATIONAL === "true") {
    const resource = /^\/api\/v1\/conversations\/[0-9a-f-]{36}(?:\/(claim|release|transfer|pause-ai|reactivate-bot|close|notes|passagens|mark-read))?$/i;
    const lead = /^\/api\/v1\/leads\/[0-9a-f-]{36}(?:\/(move|win|lose))?$/i;
    if (resource.test(path)) return ["GET", "POST", "PATCH"].includes(method);
    if (lead.test(path)) return ["GET", "POST", "PATCH"].includes(method);
    if (/^\/api\/v1\/contacts\/[0-9a-f-]{36}\/crm-summary$/i.test(path)) return method === "GET";
    if (["/api/v1/channel-sessions", "/api/v1/team/assignable", "/api/v1/pipelines", "/api/v1/pipelines/default"].includes(path)) return method === "GET";
    if (path === "/api/v1/messages") return method === "POST";
  }
  // Stored media only; the handler revalidates session, tenant, channel and object path.
  if (/^\/api\/v1\/messages\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/media$/i.test(path))
    return method === "GET";
  if (path === "/api/v1/conversations" ||
      /^\/api\/v1\/conversations\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\/messages)?$/i.test(path))
    return method === "GET"; // Os handlers reconferem auth, tenant e canal.
  if (path.startsWith("/api/") || path.startsWith("/auth/")) return false;
  if (method !== "GET" && method !== "HEAD") return false;
  return ["/", "/login", "/login/mfa", "/app", "/app/inbox"].includes(path) ||
    path.startsWith("/_next/static/") || path === "/_next/image" ||
    /\.(svg|png|jpg|jpeg|gif|webp|ico|css|js|woff2?)$/.test(path);
}
