/**
 * Dev-only CLI (not shipped in the plugin npm package).
 *
 * Single entry for local tooling — see scripts/README.md for layout.
 *
 *   node scripts/dev-tools.js <command> [flags…]
 *
 * Commands:
 *   league seed|validate   rated-season simulator / Monte Carlo harness
 *   authors                regenerate AUTHORS.txt from git history
 *   pwa-icons              regenerate client/icon-*.png
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import gitAuthors from 'grunt-git-authors'
import { runLeague } from './league/index.js'

const priorAuthors = ['Ward Cunningham <ward@c2.com>']
const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

export function runAuthors() {
  return new Promise((resolve, reject) => {
    gitAuthors.updateAuthors({ priorAuthors }, (error, filename) => {
      if (error) reject(error)
      else {
        console.log(filename, 'updated')
        resolve(filename)
      }
    })
  })
}

export async function runPwaIcons() {
  const { ensurePwaIcons } = await import('./pwa-icons.js')
  const clientDir = path.join(rootDir, 'client')
  ensurePwaIcons(clientDir)
  console.log('  Generated PWA icons in client/')
}

const COMMANDS = {
  league: runLeague,
  authors: runAuthors,
  'pwa-icons': runPwaIcons,
}

function printUsage() {
  console.error('Usage: node scripts/dev-tools.js <command> [flags…]')
  console.error('')
  console.error('Commands:')
  console.error('  league seed|validate   rated-season simulator / Monte Carlo harness')
  console.error('  authors                regenerate AUTHORS.txt from git history')
  console.error('  pwa-icons              regenerate client/icon-*.png')
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

async function runDevCli() {
  const [, , cmd, ...rest] = process.argv
  const handler = COMMANDS[cmd]
  if (!handler) {
    printUsage()
    process.exitCode = 1
    return
  }
  await handler(rest)
}

if (isMainModule) {
  runDevCli().catch(err => {
    console.error(err)
    process.exitCode = 1
  })
}
