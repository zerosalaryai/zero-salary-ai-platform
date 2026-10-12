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
  if (mode === undefined || mode === "" || mode === "false") return false;
  if (
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
  if (path === "/api/v1/conversations" ||
      /^\/api\/v1\/conversations\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\/messages)?$/i.test(path))
    return method === "GET"; // Os handlers reconferem auth, tenant e canal.
  if (path.startsWith("/api/") || path.startsWith("/auth/")) return false;
  if (method !== "GET" && method !== "HEAD") return false;
  return ["/", "/login", "/login/mfa", "/app", "/app/inbox"].includes(path) ||
    path.startsWith("/_next/static/") || path === "/_next/image" ||
    /\.(svg|png|jpg|jpeg|gif|webp|ico|css|js|woff2?)$/.test(path);
}
