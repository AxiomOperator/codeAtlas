import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { stripCommentsForRegex } from '../src/resolution/strip-comments';

// Pass-through, so a test can count how often a file's text is stripped.
vi.mock('../src/resolution/strip-comments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/resolution/strip-comments')>();
  return { ...actual, stripCommentsForRegex: vi.fn(actual.stripCommentsForRegex) };
});

/**
 * #2334: a bare JS call in a file with a `const { … }` destructuring stripped
 * every line above it to look for the binding it might go through — once per
 * call, so the work grew with the square of the file (pretix's bundled
 * pdf.js and d3). The file is scanned once; links are unchanged. Counted,
 * never timed.
 */
describe('destructured call-result work (#2334)', () => {
  let tmpDir: string | undefined;
  let cg: CodeGraph | undefined;

  afterEach(() => {
    vi.mocked(stripCommentsForRegex).mockClear();
    cg?.close();
    cg = undefined;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5 });
    tmpDir = undefined;
  });

  it('scans a file once for its bindings, not once per bare call', async () => {
    const CALLS = 40;
    const files: Record<string, string> = {
      'src/hooks.js': 'export function useAuth() {\n  function login(u) { return u; }\n  return { login };\n}\n',
      'src/helpers.js': Array.from({ length: CALLS }, (_, i) => `export function helper${i}() { return ${i}; }\n`).join(''),
      // Bare calls with no import: each one is asked whether it goes through a binding.
      'src/page.js': "import { useAuth } from './hooks';\n" +
        'export function page() {\n  const { login } = useAuth();\n' +
        Array.from({ length: CALLS }, (_, i) => `  helper${i}('{${i}');\n`).join('') +
        "  return login('ada');\n}\n",
    };
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-destructured-work-'));
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(tmpDir, file)), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, file), content);
    }
    cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    // The destructured name still reaches the hook's function.
    const page = cg.getNodesInFile('src/page.js').find((n) => n.name === 'page')!;
    const targets = cg.getOutgoingEdges(page.id).filter((e) => e.kind === 'calls')
      .map((e) => `${cg!.getNode(e.target)!.filePath}:${cg!.getNode(e.target)!.name}`);
    expect(targets).toContain('src/hooks.js:login');

    // Every strip of the text above a call in page.js: once per call before.
    const source = files['src/page.js']!;
    const prefixStrips = vi.mocked(stripCommentsForRegex).mock.calls
      .filter(([text]) => text.length > 0 && source.startsWith(text)).length;
    expect(prefixStrips).toBeLessThan(CALLS / 4);
  });
});
