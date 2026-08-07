import { execFileSync } from 'node:child_process'
import { copyFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildPublicTree } from './export-spec.js'

const dest = process.argv[2]!
const files = buildPublicTree(join(process.cwd(), 'packages', 'spec'), dest)
copyFileSync(process.argv[3]!, join(dest, 'README.md'))
writeFileSync(join(dest, '.gitignore'), 'node_modules/\ndist/\n*.tsbuildinfo\n')
console.log(`public tree: ${files.length} files -> ${dest}`)
