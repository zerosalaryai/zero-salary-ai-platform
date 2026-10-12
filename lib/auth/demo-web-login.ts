/** Cliente da porta explícita; nenhum identificador de Server Action é liberado. */
export async function demoWebLogin<T>(body: unknown): Promise<T | undefined> {
  const response = await fetch("/api/demo-web-auth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error("demo authentication denied");
  const result = await response.json();
  if (typeof result.data?.redirect === "string") {
    window.location.assign(result.data.redirect);
    return undefined;
  }
  return result.data as T;
}
