import { readFileSync } from "node:fs";
import tls from "node:tls";
import { localContext7Service } from "../local/service.js";
import type { ClientContext, ContextRequest, ContextResponse, SearchResponse } from "./types.js";

export function getDefaultCACertificates(): string[] {
  if (typeof tls.getCACertificates === "function") {
    return tls.getCACertificates("default");
  }
  return [...tls.rootCertificates];
}

export function loadCustomCACerts(
  customCACertsPath = process.env.NODE_EXTRA_CA_CERTS
): string[] | undefined {
  if (!customCACertsPath) return undefined;
  try {
    return [...getDefaultCACertificates(), readFileSync(customCACertsPath, "utf8")];
  } catch (error) {
    console.error(`[Context7 Local] Failed to load custom CA certificates:`, error);
    return undefined;
  }
}

/**
 * Search the local documentation catalog. Missing libraries are discovered
 * from their package metadata or explicit GitHub slug, indexed locally, and
 * returned only after their SQLite package is ready.
 */
export async function searchLibraries(
  query: string,
  libraryName: string,
  _context: ClientContext = {}
): Promise<SearchResponse> {
  return localContext7Service.searchLibraries(query, libraryName);
}

/**
 * Query a commit-pinned local documentation index. The service checks remote
 * freshness according to the configured interval and atomically refreshes a
 * changed repository before returning results.
 */
export async function fetchLibraryContext(
  request: ContextRequest,
  _context: ClientContext = {}
): Promise<ContextResponse> {
  return localContext7Service.fetchLibraryContext(request);
}
