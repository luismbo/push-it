import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync } from 'fflate';

export const EXTENSION_DIR = 'extension';

export interface ExtensionManifest {
  version: string;
  browser_specific_settings?: { gecko?: { id?: string } };
  [key: string]: unknown;
}

export function readExtensionManifest(): ExtensionManifest {
  return JSON.parse(readFileSync(join(EXTENSION_DIR, 'manifest.json'), 'utf8')) as ExtensionManifest;
}

/**
 * Zips extension/ with manifest.json at the archive root (required by Firefox).
 * `manifest` replaces the on-disk manifest when given (e.g. to override the add-on ID).
 */
export function zipExtension(manifest?: ExtensionManifest): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path, `${prefix}${name}/`);
      else files[`${prefix}${name}`] = readFileSync(path);
    }
  };
  walk(EXTENSION_DIR, '');
  if (manifest) {
    files['manifest.json'] = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  }
  return zipSync(files, { level: 9 });
}
