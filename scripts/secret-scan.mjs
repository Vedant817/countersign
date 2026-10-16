import { spawnSync } from 'node:child_process'
import { copyFile, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const executable = process.platform === 'win32' ? 'gitleaks.exe' : 'gitleaks'
const config = path.join(repoRoot, '.gitleaks.toml')
const gitleaks = (args, options = {}) =>
  spawnSync(executable, args, { cwd: repoRoot, stdio: 'inherit', ...options })

function checkExecution(result) {
  if (result.error?.code === 'ENOENT') {
    throw new Error(
      [
        'gitleaks is required but was not found on PATH.',
        'Install it, then reopen your terminal:',
        '  Windows: winget install --id Gitleaks.Gitleaks --exact',
        '  macOS:   brew install gitleaks',
        '  Scoop:   scoop install gitleaks',
        'Install instructions: https://github.com/gitleaks/gitleaks#installing',
      ].join('\n'),
    )
  }
  if (result.error) {
    throw new Error(`failed to start gitleaks: ${result.error.message}`)
  }
}

let version
try {
  version = gitleaks(['version'], { stdio: 'ignore' })
  checkExecution(version)
} catch (error) {
  console.error(`secret-scan: ${error.message}`)
  process.exit(1)
}
if (version.status !== 0) process.exit(version.status ?? 1)

const files = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  cwd: repoRoot,
  encoding: 'utf8',
})
if (files.error || files.status !== 0) {
  console.error(
    `secret-scan: could not list repository files${files.error ? `: ${files.error.message}` : ''}`,
  )
  process.exit(files.status || 1)
}

const snapshot = await mkdtemp(path.join(os.tmpdir(), 'countersign-secret-scan-'))
let exitCode = 0
try {
  for (const relativePath of files.stdout.split('\0').filter(Boolean)) {
    const source = path.resolve(repoRoot, relativePath)
    if (!source.startsWith(`${repoRoot}${path.sep}`)) continue
    try {
      if (!(await lstat(source)).isFile()) continue
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    const destination = path.join(snapshot, ...relativePath.split('/'))
    await mkdir(path.dirname(destination), { recursive: true })
    await copyFile(source, destination)
  }

  const workingTree = gitleaks(['dir', '.', '--redact', '--config', config], { cwd: snapshot })
  checkExecution(workingTree)
  if (workingTree.status !== 0) exitCode = workingTree.status ?? 1

  const history = gitleaks(['detect', '--source', repoRoot, '--redact', '--config', config])
  checkExecution(history)
  if (history.status !== 0) exitCode = history.status ?? 1
} catch (error) {
  console.error(`secret-scan: failed to prepare or scan repository files: ${error.message}`)
  exitCode = 1
} finally {
  await rm(snapshot, { recursive: true, force: true })
}

process.exit(exitCode)
