import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export interface BuildInfo {
  version: string;
  commit: string;
}

// __dirname is <root>/src under tsx and <root>/dist under `node dist/server.js`,
// so package.json is one level up either way.
const projectRoot = path.resolve(__dirname, '..');

let cachedVersion: string | null = null;
let cachedGitCommit: string | null = null;

function readVersion(): string {
  try {
    const raw = fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version?.trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Asking git is a development convenience only. A production checkout may have
 * no readable .git directory, so failing to answer must never be fatal.
 */
function readGitCommit(): string {
  try {
    return (
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: projectRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
      }).trim() || 'unknown'
    );
  } catch {
    return 'unknown';
  }
}

/**
 * HERMES_GIT_COMMIT is the production answer: deploy.sh exports it for the
 * service, so /health reports the commit that was actually checked out without
 * shelling out. It is read on every call because it is free; the git fallback is
 * cached because it is not.
 */
export function buildInfo(): BuildInfo {
  if (cachedVersion === null) {
    cachedVersion = readVersion();
  }

  const fromEnv = process.env.HERMES_GIT_COMMIT?.trim();
  if (fromEnv) {
    return { version: cachedVersion, commit: fromEnv };
  }

  if (cachedGitCommit === null) {
    cachedGitCommit = readGitCommit();
  }

  return { version: cachedVersion, commit: cachedGitCommit };
}
