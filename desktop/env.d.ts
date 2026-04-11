/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GATEWAY_URL?: string;
  readonly VITE_GATEWAY_TOKEN?: string;
  readonly VITE_GATEWAY_CLIENT_NAME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
