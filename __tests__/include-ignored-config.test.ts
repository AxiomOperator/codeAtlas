/**
 * `codegraph.json` `includeIgnored` loader (#970, #976 / #622, #699).
 *
 * Parsing, validation, and mtime-caching of the opt-in patterns that re-include
 * gitignored directories for embedded-repo discovery. The behavioral end of this
 * feature (scanDirectory / discoverEmbeddedRepoRoots / sync honoring the patterns)
 * lives in `multi-repo-workspace.test.ts`; these are the loader unit tests,
 * mirroring the `extensions` loader coverage in `extension-mapping.test.ts`.
 *
 * Invariant under test: every failure mode degrades to the zero-config default
 * (empty patterns → `.gitignore` fully respected), never a throw.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadIncludeIgnoredPatterns, loadExtensionOverrides, clearProjectConfigCache, addIncludeIgnoredPatterns } from '../src/project-config';

describe('includeIgnored loader (codegraph.json)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-includeignored-'));
    clearProjectConfigCache();
  });
  afterEach(() => {
    clearProjectConfigCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const writeConfig = (obj: unknown) =>
    fs.writeFileSync(
      path.join(dir, 'codegraph.json'),
      typeof obj === 'string' ? obj : JSON.stringify(obj)
    );

  it('returns an empty list when there is no codegraph.json (the default)', () => {
    expect(loadIncludeIgnoredPatterns(dir)).toEqual([]);
  });

  it('loads a well-formed pattern array', () => {
    writeConfig({ includeIgnored: ['packages/', 'services/'] });
    expect(loadIncludeIgnoredPatterns(dir)).toEqual(['packages/', 'services/']);
  });

  it('trims whitespace and drops blank / non-string entries', () => {
    writeConfig({ includeIgnored: ['  packages/  ', '', '   ', 42, null, 'services/'] });
    expect(loadIncludeIgnoredPatterns(dir)).toEqual(['packages/', 'services/']);
  });

  it('ignores a non-array includeIgnored value without throwing', () => {
    writeConfig({ includeIgnored: 'packages/' });
    expect(loadIncludeIgnoredPatterns(dir)).toEqual([]);
  });

  it('ignores malformed JSON without throwing', () => {
    writeConfig('{ not: valid json ');
    expect(loadIncludeIgnoredPatterns(dir)).toEqual([]);
  });

  it('returns [] when the field is absent but other config is present', () => {
    writeConfig({ extensions: { '.foo': 'typescript' } });
    expect(loadIncludeIgnoredPatterns(dir)).toEqual([]);
  });

  it('coexists with extensions in one file (shared single parse)', () => {
    writeConfig({ extensions: { '.foo': 'typescript' }, includeIgnored: ['vendor/'] });
    expect(loadExtensionOverrides(dir)).toEqual({ '.foo': 'typescript' });
    expect(loadIncludeIgnoredPatterns(dir)).toEqual(['vendor/']);
  });

  it('picks up a changed config (mtime-invalidated cache)', () => {
    writeConfig({ includeIgnored: ['packages/'] });
    expect(loadIncludeIgnoredPatterns(dir)).toEqual(['packages/']);

    writeConfig({ includeIgnored: ['services/'] });
    // Force a distinct mtime in case the filesystem clock is coarse.
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(path.join(dir, 'codegraph.json'), future, future);

    expect(loadIncludeIgnoredPatterns(dir)).toEqual(['services/']);
  });

  it('drops the patterns again when the config file is removed', () => {
    writeConfig({ includeIgnored: ['packages/'] });
    expect(loadIncludeIgnoredPatterns(dir)).toEqual(['packages/']);

    fs.rmSync(path.join(dir, 'codegraph.json'));
    expect(loadIncludeIgnoredPatterns(dir)).toEqual([]);
  });
});

describe('addIncludeIgnoredPatterns (codegraph.json writer, #1156)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-addincludeignored-'));
    clearProjectConfigCache();
  });
  afterEach(() => {
    clearProjectConfigCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const readConfig = () => JSON.parse(fs.readFileSync(path.join(dir, 'codegraph.json'), 'utf-8'));

  it('creates codegraph.json when none exists', () => {
    expect(addIncludeIgnoredPatterns(dir, ['mtc-a/', 'mtc-b/'])).toBe(2);
    expect(loadIncludeIgnoredPatterns(dir)).toEqual(['mtc-a/', 'mtc-b/']);
  });

  it('merges into an existing list, preserving other keys and de-duping', () => {
    fs.writeFileSync(
      path.join(dir, 'codegraph.json'),
      JSON.stringify({ extensions: { '.foo': 'typescript' }, includeIgnored: ['mtc-a/'] }),
    );
    expect(addIncludeIgnoredPatterns(dir, ['mtc-a/', 'mtc-b/'])).toBe(1); // only mtc-b/ is new
    const parsed = readConfig();
    expect(parsed.includeIgnored).toEqual(['mtc-a/', 'mtc-b/']);
    expect(parsed.extensions).toEqual({ '.foo': 'typescript' }); // untouched
  });

  it('is idempotent — re-adding the same patterns adds nothing', () => {
    addIncludeIgnoredPatterns(dir, ['mtc-a/']);
    expect(addIncludeIgnoredPatterns(dir, ['mtc-a/'])).toBe(0);
    expect(loadIncludeIgnoredPatterns(dir)).toEqual(['mtc-a/']);
  });

  it('replaces a non-array includeIgnored value rather than crashing', () => {
    fs.writeFileSync(path.join(dir, 'codegraph.json'), JSON.stringify({ includeIgnored: 'oops' }));
    expect(addIncludeIgnoredPatterns(dir, ['mtc-a/'])).toBe(1);
    expect(loadIncludeIgnoredPatterns(dir)).toEqual(['mtc-a/']);
  });

  it('refuses to clobber a malformed existing codegraph.json (throws, leaves file intact)', () => {
    const bad = '{ not: valid json ';
    fs.writeFileSync(path.join(dir, 'codegraph.json'), bad);
    expect(() => addIncludeIgnoredPatterns(dir, ['mtc-a/'])).toThrow();
    expect(fs.readFileSync(path.join(dir, 'codegraph.json'), 'utf-8')).toBe(bad);
  });

  it.each([
    ['an array', '["mtc-a/"]'],
    ['null', 'null'],
    ['a string', '"x"'],
  ])('refuses to overwrite a codegraph.json that is %s (throws, leaves file intact)', (_kind, body) => {
    fs.writeFileSync(path.join(dir, 'codegraph.json'), body);
    expect(() => addIncludeIgnoredPatterns(dir, ['mtc-a/'])).toThrow(/must contain a JSON object/);
    expect(fs.readFileSync(path.join(dir, 'codegraph.json'), 'utf-8')).toBe(body);
  });

  it('treats an unreadable codegraph.json as an error, not as missing', () => {
    // A directory named codegraph.json reads with EISDIR on every platform —
    // the same "exists but can't be read" class as EACCES.
    fs.mkdirSync(path.join(dir, 'codegraph.json'));
    expect(() => addIncludeIgnoredPatterns(dir, ['mtc-a/'])).toThrow(/could not read codegraph\.json/);
    expect(fs.statSync(path.join(dir, 'codegraph.json')).isDirectory()).toBe(true);
  });

  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
    'treats an EACCES codegraph.json as an error and leaves it untouched',
    () => {
      const file = path.join(dir, 'codegraph.json');
      fs.writeFileSync(file, '{"includeIgnored":["keep/"]}');
      fs.chmodSync(file, 0o000);
      try {
        expect(() => addIncludeIgnoredPatterns(dir, ['mtc-a/'])).toThrow(/EACCES/);
      } finally {
        fs.chmodSync(file, 0o644);
      }
      expect(fs.readFileSync(file, 'utf-8')).toBe('{"includeIgnored":["keep/"]}');
    },
  );

  it('writes atomically — no temp file left behind', () => {
    addIncludeIgnoredPatterns(dir, ['mtc-a/']);
    addIncludeIgnoredPatterns(dir, ['mtc-b/']);
    expect(fs.readdirSync(dir)).toEqual(['codegraph.json']);
    expect(readConfig().includeIgnored).toEqual(['mtc-a/', 'mtc-b/']);
  });

  it('writes pretty-printed, newline-terminated JSON', () => {
    addIncludeIgnoredPatterns(dir, ['mtc-a/']);
    const raw = fs.readFileSync(path.join(dir, 'codegraph.json'), 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toContain('\n  "includeIgnored"'); // 2-space indent
  });
});
