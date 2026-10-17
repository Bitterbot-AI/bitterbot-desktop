export type SoapboxSetupStatus = {
  configured: boolean;
  configuredRole?: string;
  platformSupported: boolean;
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
