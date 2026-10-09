// Recreates workspace package symlinks as proper Windows NTFS junctions.
// pnpm creates Unix-style symlinks when run from Git Bash; Windows Node.js
// cannot follow them. This script replaces them with junction points.
// Runs automatically via the root postinstall script on Windows only.

import { execSync } from 'child_process'
import { rmSync } from 'fs'
import { resolve } from 'path'
import { fileURLToPath } from 'url'

if (process.platform !== 'win32') process.exit(0)

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')

const links = [
  { from: 'apps/api/node_modules/@billing/db',              to: 'packages/db' },
  { from: 'apps/api/node_modules/@billing/domain-registry', to: 'packages/domain-registry' },
  { from: 'apps/api/node_modules/@billing/gst-engine',      to: 'packages/gst-engine' },
  { from: 'apps/api/node_modules/@billing/shared',          to: 'packages/shared' },
  { from: 'apps/api/node_modules/@billing/pdf',             to: 'packages/pdf' },
  { from: 'apps/web/node_modules/@billing/shared',          to: 'packages/shared' },
]

for (const { from, to } of links) {
  const fromPath = resolve(root, from).replaceAll('/', '\\')
  const toPath   = resolve(root, to).replaceAll('/', '\\')
  try {
    rmSync(fromPath, { recursive: true, force: true })
    execSync(
      `powershell -Command "New-Item -ItemType Junction -Path '${fromPath}' -Target '${toPath}'"`,
      { stdio: 'pipe' }
    )
    console.log(`✓ junction: ${from}`)
  } catch (e) {
    console.warn(`⚠ junction failed for ${from}: ${e.message}`)
  }
}
