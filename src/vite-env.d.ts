/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Overrides the parcel catalogue host. Unset in a normal build. */
  readonly VITE_PARCEL_CATALOG?: string
  /** Rewrites the absolute data host, for sandboxes without open internet. */
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** The commit this bundle was built from, injected by vite.config.ts. */
declare const __BUILD_COMMIT__: string
