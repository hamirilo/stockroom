/// <reference types="vite/client" />

/** A build with fewer features (docs/LIMITS.md, src/lib/limits.ts). */
interface ImportMetaEnv {
  readonly STOCKROOM_KINDS?: string;
  readonly STOCKROOM_NO_CONNECT?: string;
  readonly STOCKROOM_NO_UPDATE?: string;
  readonly STOCKROOM_NAME?: string;
}
