import {
  loadModelCatalog,
  type ModelCatalogEntry,
  resetModelCatalogCacheForTest,
} from "../agents/model-catalog.js";
import { loadConfig } from "../config/config.js";

export type GatewayModelChoice = ModelCatalogEntry;

// Test-only escape hatch: model catalog is cached at module scope for the
// process lifetime, which is fine for the real gateway daemon, but makes
// isolated unit tests harder. Keep this intentionally obscure.
export function __resetModelCatalogCacheForTest() {
  resetModelCatalogCacheForTest();
}

export async function loadGatewayModelCatalog(): Promise<GatewayModelChoice[]> {
  return await loadModelCatalog({ config: loadConfig() });
}

/**
 * Bust the process-lifetime catalog cache and reload. Must be called after
 * any write that changes which providers/models exist (auth profile saved,
 * models.providers config edit) or new entries stay invisible in every
 * picker until the gateway restarts.
 */
export async function refreshGatewayModelCatalog(): Promise<GatewayModelChoice[]> {
  return await loadModelCatalog({ config: loadConfig(), useCache: false });
}
