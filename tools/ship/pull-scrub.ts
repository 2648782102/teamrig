import type { ScrubRule } from '../scrub/rules.ts';
import { formatFinding, scanText } from '../scrub/scan.ts';

/**
 * The private-data scrub of what a merge posts to GitHub (T3442). The commit hooks and CI scrub commits and files, but
 * a pull request's title and body are written to a public repo by `ship.ts merge` alone, so it scans them with the
 * same generic rules and private denylist before the approval gate, and refuses a finding where its line is fixed.
 */

/** One text a merge posts, and where its lines can be fixed: a file's path, or a name for text the merge builds. */
export interface PostedText {
  readonly source: string;
  readonly text: string;
}

/**
 * Why `texts` cannot be posted, naming each finding's source, line and rule (a generic rule's match stays masked); null
 * when the rules find nothing. A string `rules` is why they could not be loaded, which refuses too: the text was not
 * scanned.
 */
export function postedTextRefusal(texts: readonly PostedText[], rules: readonly ScrubRule[] | string): string | null {
  if (typeof rules === 'string') return `the pull request text was not scrubbed for private data: ${rules}`;
  const findings = texts.flatMap(posted => scanText(posted.source, posted.text, rules));
  if (findings.length === 0) return null;
  return `the pull request text fails the private-data scrub, ${findings.length} finding(s): ${findings.map(formatFinding).join('; ')}; take each out where it is written, then ship again`;
}
