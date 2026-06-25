export function joinProfileApiUrl(baseUrl: URL | string, path: string) {
  const base = new URL(baseUrl);
  const relativePath = path.replace(/^\/+/, "");

  base.pathname = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;

  return new URL(relativePath, base);
}
