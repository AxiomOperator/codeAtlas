/**
 * Installer Tests
 *
 * Tests for installer config-writer fixes:
 * - readJsonFile error handling
 *
 * (The CLAUDE.md instructions block is no longer written — see issue
 * #529. The marker-based install/uninstall self-heal is covered in
 * `installer-targets.test.ts`.)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// We test the exported functions from config-writer
import {
  writeMcpConfig,
} from '../src/installer/config-writer';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-installer-test-'));
}

function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('Installer Config Writer', () => {
  let origCwd: string;
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    origCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    cleanupTempDir(tempDir);
  });

  describe('readJsonFile error handling', () => {
    it('should return empty object for non-existent file', () => {
      // writeMcpConfig reads .mcp.json - if it doesn't exist, it should create it
      writeMcpConfig('local');

      const mcpJson = path.join(tempDir, '.mcp.json');
      expect(fs.existsSync(mcpJson)).toBe(true);

      const content = JSON.parse(fs.readFileSync(mcpJson, 'utf-8'));
      expect(content.mcpServers).toBeDefined();
      expect(content.mcpServers.codegraph).toBeDefined();
    });

    it('should refuse to touch corrupted JSON, warning instead of replacing it', () => {
      // Create a corrupted .mcp.json
      const mcpJson = path.join(tempDir, '.mcp.json');
      fs.writeFileSync(mcpJson, '{ this is not valid json !!!');

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Should not throw - the file is left for the user to fix
      writeMcpConfig('local');

      expect(warnSpy).toHaveBeenCalled();
      const warnMsg = warnSpy.mock.calls[0][0];
      expect(warnMsg).toContain('Warning');
      expect(warnMsg).toContain('left it untouched');

      // Untouched, and no backup needed because nothing was replaced
      expect(fs.readFileSync(mcpJson, 'utf-8')).toBe('{ this is not valid json !!!');
      expect(fs.existsSync(mcpJson + '.backup')).toBe(false);

      warnSpy.mockRestore();
    });

    it('should preserve existing valid config when adding codegraph', () => {
      const mcpJson = path.join(tempDir, '.mcp.json');
      fs.writeFileSync(mcpJson, JSON.stringify({
        mcpServers: { other: { command: 'other-tool' } },
        customField: 'preserved',
      }, null, 2));

      writeMcpConfig('local');

      const content = JSON.parse(fs.readFileSync(mcpJson, 'utf-8'));
      expect(content.mcpServers.codegraph).toBeDefined();
      expect(content.mcpServers.other).toBeDefined();
      expect(content.customField).toBe('preserved');
    });
  });
});
