import { type Bundle, readBundle } from "./bundle.js";

export interface InspectResult extends Bundle {
  /** archive entry name -> byte size */
  sizes: Record<string, number>;
  checksumsVerified: true;
}

/** Read + fully verify a bundle without touching any repo. Throws on any integrity problem. */
export function inspect(bundlePath: string): InspectResult {
  const bundle = readBundle(bundlePath);
  const sizes: Record<string, number> = {};
  for (const [name, data] of Object.entries(bundle.entries)) {
    sizes[name] = data.byteLength;
  }
  return { ...bundle, sizes, checksumsVerified: true };
}
