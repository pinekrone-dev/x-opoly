/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Overrides the parcel catalogue host. Unset in a normal build. */
  readonly VITE_PARCEL_CATALOG?: string
  /** Rewrites the absolute data host, for sandboxes without open internet. */
  readonly VITE_PARCEL_PROXY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
