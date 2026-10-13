/** Cliente da porta explícita; nenhum identificador de Server Action é liberado. */
export async function demoWebLogin<T>(body: unknown): Promise<T | undefined> {
  const response = await fetch("/api/demo-web-auth", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error("demo authentication denied");
  const result = await response.json();
  if (!result || result.error || !result.data || typeof result.data !== "object")
    throw new Error("demo authentication denied");
  const kind = body && typeof body === "object" && "kind" in body ? body.kind : undefined;
  // Lifecycle actions must never treat a malformed 2xx envelope as success.
  if (kind === "logout" && result.data.redirect !== "/login")
    throw new Error("demo authentication denied");
  if (kind === "refresh" && result.data.refreshed !== true &&
      result.data.redirect !== "/login" && result.data.redirect !== "/login/mfa")
    throw new Error("demo authentication denied");
  if (typeof result.data.redirect === "string") {
    window.location.assign(result.data.redirect);
    return undefined;
  }
  return result.data as T;
}
