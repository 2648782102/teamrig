import { EXIT_CLEAN, EXIT_FINDINGS, EXIT_USAGE } from '../lib/exit.ts';
import { GitError, type Git } from '../lib/git.ts';
import { parseDenylist } from './denylist.ts';
import { GENERIC_RULES, type ScrubRule } from './rules.ts';
import { formatFinding, scanText, type Finding } from './scan.ts';
import {
  commitMessageInputs,
  isBinary,
  messageFileInput,
  stagedInputs,
  treeInputs,
  type ReadFile,
  type ScanInput,
} from './sources.ts';

export interface ScrubOptions {
  readonly staged: boolean;
  readonly tree: boolean;
  /** A commit message file (the commit-msg hook's argument). */
  readonly messageFile: string | undefined;
  /** Scan the messages of the commits in this revision range. */
  readonly range: string | undefined;
  /** Explicit denylist path; otherwise git config `teamrig.scrubDenylist`, if set. */
  readonly denylistPath: string | undefined;
}

export interface ScrubDeps {
  readonly git: Git;
  readonly readFile: ReadFile;
  readonly out: (line: string) => void;
}

export const DENYLIST_CONFIG_KEY = 'teamrig.scrubDenylist';

export async function runScrub(options: ScrubOptions, deps: ScrubDeps): Promise<number> {
  if (!options.staged && !options.tree && options.messageFile === undefined && options.range === undefined) {
    deps.out('scrub: nothing to scan; pass --staged, --tree, --message <file> or --range <revisions>');
    return EXIT_USAGE;
  }
  const rules = await scrubRules(options.denylistPath, deps);
  if (typeof rules === 'string') {
    deps.out(`scrub: ${rules}`);
    return EXIT_USAGE;
  }
  const inputs = await collectInputs(options, deps);
  const findings: Finding[] = [];
  let binaries = 0;
  for (const input of inputs) {
    if (isBinary(input.content)) {
      binaries += 1;
      continue;
    }
    findings.push(...scanText(input.source, input.content.toString(), rules));
  }
  for (const finding of findings) {
    deps.out(formatFinding(finding));
  }
  const scope =
    `${inputs.length - binaries} input(s), ${binaries} binary skipped, ` +
    `${GENERIC_RULES.length} generic + ${rules.length - GENERIC_RULES.length} private rule(s)`;
  deps.out(findings.length === 0 ? `scrub: clean (${scope})` : `scrub: ${findings.length} finding(s) (${scope})`);
  return findings.length === 0 ? EXIT_CLEAN : EXIT_FINDINGS;
}

/** What `scrubRules` reads: the repo's git config, and the denylist file it names. */
export type RuleDeps = Pick<ScrubDeps, 'git' | 'readFile'>;

/**
 * The rules every scan runs: the generic ones, then the private denylist (`denylistPath`, else the repo's git config
 * `teamrig.scrubDenylist`). Returns why it cannot, instead, outside a work tree or with a configured list it cannot
 * use, so no caller scans on the generic rules alone where a denylist was meant to apply (ship's pull request text,
 * T3442, scans with these too).
 */
export async function scrubRules(denylistPath: string | undefined, deps: RuleDeps): Promise<readonly ScrubRule[] | string> {
  if (!(await insideWorkTree(deps.git))) {
    return `not inside a git work tree, where git config ${DENYLIST_CONFIG_KEY} names the private denylist; run it from inside the repo`;
  }
  const denylist = await loadDenylist(denylistPath, deps);
  return typeof denylist === 'string' ? denylist : [...GENERIC_RULES, ...denylist];
}

/**
 * True inside a git work tree. Outside one, git config holds no repo's denylist, so a scan would pass on the generic
 * rules alone, and there is no index or tree to read.
 */
async function insideWorkTree(git: Git): Promise<boolean> {
  try {
    return (await git.text(['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch (error) {
    if (error instanceof GitError) {
      return false;
    }
    throw error;
  }
}

/** Returns the denylist rules, or an error message. A configured list that is missing or empty fails closed. */
async function loadDenylist(explicitPath: string | undefined, deps: RuleDeps): Promise<ScrubRule[] | string> {
  const path = explicitPath ?? (await deps.git.text(['config', '--default', '', '--get', DENYLIST_CONFIG_KEY])).trim();
  if (path === '') {
    return [];
  }
  let text: string;
  try {
    text = (await deps.readFile(path)).toString('utf8');
  } catch (error) {
    return `cannot read the private denylist (${errorMessage(error)}); refusing to scan without it`;
  }
  try {
    const rules = parseDenylist(text);
    return rules.length > 0 ? rules : 'the private denylist has no rules; refusing to scan without it';
  } catch (error) {
    return errorMessage(error);
  }
}

async function collectInputs(options: ScrubOptions, deps: ScrubDeps): Promise<ScanInput[]> {
  const inputs: ScanInput[] = [];
  if (options.staged) {
    inputs.push(...(await stagedInputs(deps.git)));
  }
  if (options.tree) {
    inputs.push(...(await treeInputs(deps.git, deps.readFile)));
  }
  if (options.messageFile !== undefined) {
    const text = (await deps.readFile(options.messageFile)).toString('utf8');
    inputs.push(messageFileInput(options.messageFile, text));
  }
  if (options.range !== undefined) {
    inputs.push(...(await commitMessageInputs(deps.git, options.range)));
  }
  return inputs;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
