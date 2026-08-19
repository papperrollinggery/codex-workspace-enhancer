import { readFile } from "node:fs/promises";

export async function readAssetConsoleApiToken(tokenPath) {
  if (!tokenPath) throw new Error("Asset Console API token path is unavailable");
  const token = (await readFile(tokenPath, "utf8")).trim();
  if (token.length < 32 || /[\r\n\0]/u.test(token)) throw new Error("Asset Console API token is invalid");
  return token;
}

export function authenticatedAssetConsoleHeaders(headers, apiToken) {
  if (typeof apiToken !== "string" || apiToken.length < 32) throw new Error("Asset Console API token is invalid");
  const result = { ...headers, host: "127.0.0.1:5177" };
  for (const name of Object.keys(result)) {
    if (["origin", "referer", "connection", "content-length", "x-asset-console-token"].includes(name.toLowerCase())) {
      delete result[name];
    }
  }
  result["x-asset-console-token"] = apiToken;
  return result;
}
