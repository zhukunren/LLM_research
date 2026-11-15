import { chmodSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// A separate service account must be able to read the public build, even
// when the build runs with a restrictive umask. Only change generated assets.
function prepareDirectory(directory) {
  chmodSync(directory, 0o755)
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) prepareDirectory(path)
    else if (entry.isFile()) chmodSync(path, 0o644)
  }
}

if (process.platform !== 'win32') {
  prepareDirectory(resolve(dirname(fileURLToPath(import.meta.url)), '../dist'))
}
