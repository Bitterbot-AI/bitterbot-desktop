import { readFileSync } from "node:fs";
import path from "node:path";
import type { loadConfig } from "../config/config.js";
import type { MeshBridge } from "./mesh-protocol.js";
import { resolveStateDir } from "../config/paths.js";
import { SoapboxClient } from "../infra/soapbox-client.js";
import { ComputeMeshService, type MeshBackend } from "./mesh-service.js";
import { ComputeMeshStore } from "./mesh-store.js";

export async function startComputeMesh(
  bridge: MeshBridge,
  cfg: ReturnType<typeof loadConfig>,
): Promise<ComputeMeshService> {
  const config = cfg.plugins?.entries?.["soapbox-compute"]?.config;
  const backend = (): MeshBackend | null => {
    // Only an explicitly local pilot coordinator has authority to grant peers access.
    // Participant/buyer installations can use the mesh without a local coordinator.
    if (
      config?.mode === "participant" ||
      config?.mode === "setup" ||
      typeof config?.stateDirectory !== "string" ||
      !path.isAbsolute(config.stateDirectory)
    )
      return null;
    try {
      if (config.mode === "mesh-operator") {
        const local = JSON.parse(
          readFileSync(path.join(config.stateDirectory, "mesh-operator.json"), "utf8"),
        );
        if (
          local.version !== 1 ||
          local.chain_id !== 84532 ||
          !/^http:\/\/127\.0\.0\.1:\d+$/.test(local.url) ||
          !/^[a-f0-9]{64}$/.test(local.admin)
        )
          return null;
        return {
          admin: new SoapboxClient(local.url, local.admin),
          client: (token) => new SoapboxClient(local.url, token),
        };
      }
      const credentials = JSON.parse(
        readFileSync(path.join(config.stateDirectory, "credentials.json"), "utf8"),
      ) as { buyer: string };
      const coordinator = JSON.parse(
        readFileSync(path.join(config.stateDirectory, "coordinator.json"), "utf8"),
      ) as { payments?: { chain_id: number } };
      if (coordinator.payments?.chain_id !== 84532) return null;
      const url = "http://127.0.0.1:8787";
      return {
        admin: new SoapboxClient(url, credentials.buyer),
        client: (token) => new SoapboxClient(url, token),
      };
    } catch {
      return null;
    }
  };
  const mesh = new ComputeMeshService(
    bridge,
    new ComputeMeshStore(path.join(resolveStateDir(), "compute/mesh.sqlite")),
    backend,
  );
  try {
    await mesh.start();
    return mesh;
  } catch (error) {
    await mesh.stop();
    throw error;
  }
}
