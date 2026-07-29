import { homedir } from 'node:os'

/**
 * Returns the JOKER home directory. JOKER_HOME is intentionally supported for
 * isolated QA runs and portable deployments; normal users keep the OS home.
 */
export function getJokerHomeDir(): string {
  return process.env['JOKER_HOME']?.trim() || homedir()
}
