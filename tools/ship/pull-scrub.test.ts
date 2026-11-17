import assert from 'node:assert/strict';
import { join } from 'node:path/posix';
import { test } from 'node:test';
import { parseDenylist } from '../scrub/denylist.ts';
import { GENERIC_RULES } from '../scrub/rules.ts';
import { postedTextRefusal } from './pull-scrub.ts';

/** Built from parts, so this file holds no home path for the repo's own scrub to refuse. */
const HOME_PATH = join('/', 'home', 'dana', 'notes');
const RULES = [...GENERIC_RULES, ...parseDenylist('acme-internal\n')];

test('a clean title, subjects and text post: no refusal', () => {
  const posted = [
    { source: 'the pull request title', text: 'Merge t9-change into main: 1 commit(s)' },
    { source: 'C:/tasks/T9/pr.md', text: '## What\nA change.\n\nReach: teamrig development\n' },
  ];
  assert.equal(postedTextRefusal(posted, RULES), null);
});

test('a generic finding names its file and line, its match masked, as a public log may show it (T3442)', () => {
  const refusal = postedTextRefusal([{ source: 'C:/tasks/T9/pr.md', text: `## What\n\nRead ${HOME_PATH} first.\n` }], RULES);
  assert.match(refusal ?? '', /^the pull request text fails the private-data scrub, 1 finding\(s\): C:\/tasks\/T9\/pr\.md:3:6 home-path: /);
  assert.match(refusal ?? '', /; take each out where it is written, then ship again$/);
  assert.ok(!(refusal ?? '').includes('dana'), refusal ?? '');
});

test('a private denylist term is found in any text posted, each finding named where it is written', () => {
  const refusal = postedTextRefusal(
    [
      { source: 'the commit subjects', text: 'cli: a\nfix: the Acme-Internal feed' },
      { source: 'C:/notes/pr.md', text: 'Reach: one team (acme-internal)\n' },
    ],
    RULES,
  );
  assert.equal(
    refusal,
    'the pull request text fails the private-data scrub, 2 finding(s): the commit subjects:2:10 denylist:1: private denylist term "Acme-Internal"; ' +
      'C:/notes/pr.md:1:18 denylist:1: private denylist term "acme-internal"; take each out where it is written, then ship again',
  );
});

test('rules that could not be loaded refuse too: the text was never scanned', () => {
  assert.equal(
    postedTextRefusal([{ source: 'C:/tasks/T9/pr.md', text: 'Reach: all users\n' }], 'cannot read the private denylist (gone); refusing to scan without it'),
    'the pull request text was not scrubbed for private data: cannot read the private denylist (gone); refusing to scan without it',
  );
});
