export type SoapboxSetupProfile = {
  id: string;
  role: "buyer" | "operator" | "mesh-operator";
  name: string;
  active: boolean;
};
export type SoapboxSetupStatus = {
  configured: boolean;
  configuredRole?: string;
  profiles?: SoapboxSetupProfile[];
  addingProfile?: boolean;
  canManageProfiles?: boolean;
  platformSupported: boolean;
  bundledRuntimeAvailable?: boolean;
  hasWalletCredentials: boolean;
  walletAddress: string | null;
  release: { url: string; filename: string; bytes: number };
  enrollment?: {
    role: "buyer" | "operator";
    id: string;
    url: string;
    address: string;
    chain_id: 84532;
  };
  progress: {
    state: "idle" | "uploading" | "preparing" | "ready" | "failed";
    message: string;
    percent: number;
  };
};
