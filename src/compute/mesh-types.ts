/** Browser-safe wire types. Keep runtime/SQLite dependencies out of the desktop bundle. */
export type ComputeMeshSnapshot = {
  enabled: boolean;
  ready: boolean;
  error: string | null;
  peerId?: string;
  hosting: boolean;
  pools: string[];
  projects: string[];
  localWorkers: number;
  peers: Array<{
    peerId: string;
    pubkey: string;
    issuedAt: number;
    expiresAt: number;
    accepting: boolean;
    cpuSlots: number;
    gpuSlots: number;
    memoryMib: number;
    models: Array<{ model: string; digest: string }>;
    admitted: boolean;
    reliability: number;
  }>;
  batches: Array<{
    id: string;
    kind: string;
    status: string;
    items: number;
    shards: Array<{
      status: string;
      peerId: string;
      error?: string;
      cancelledRemoteStatus?: string;
    }>;
  }>;
  activity: Array<{ at: number; peer: string; kind: string; items: number }>;
  permissions: Array<{ peerId: string; enabled: boolean; pools: string[]; projects: string[] }>;
  payments: string;
  verification: string;
};
