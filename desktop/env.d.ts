/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GATEWAY_URL?: string;
  readonly VITE_GATEWAY_TOKEN?: string;
  readonly VITE_GATEWAY_CLIENT_NAME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface BitterbotElectronAPI {
  platform: string;
  getGatewayUrl: () => string;
  getVersion: () => string;
  windowMinimize: () => void;
  windowMaximize: () => void;
  windowClose: () => void;
  openExternal: (url: string) => void;
}

interface Window {
  bitterbot: BitterbotElectronAPI;
}
