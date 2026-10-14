/** Exact configured public origin; never forwarded-header authority. */
export function demoCrmOriginAllowed(req: Request, publicUrl = process.env.NEXT_PUBLIC_APP_URL): boolean {
  try {
    if (!publicUrl || req.headers.has("next-action") || req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return false;
    const trusted = new URL(publicUrl);
    if (trusted.username || trusted.password || trusted.search || trusted.hash || trusted.pathname !== "/" ||
      (trusted.protocol !== "https:" && !(trusted.protocol === "http:" && ["localhost", "127.0.0.1"].includes(trusted.hostname)))) return false;
    return req.headers.get("origin") === trusted.origin;
  } catch { return false; }
}
