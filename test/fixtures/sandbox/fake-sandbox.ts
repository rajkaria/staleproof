import type { SandboxClient, SandboxCommand, SandboxCommandResult, SandboxVm } from '../../../src/runner/vercel-sandbox.js';

/**
 * A fake Vercel Sandbox for the runner's and the App's tests: commands, files and network
 * changes are recorded, and answered the way the real sandbox would for the runner's setup
 * (uv, the scratch FalkorDB), unpacking, installs and flushes. The example itself is answered
 * by `program`, which sees the commits installed in the virtualenv it runs with.
 */

export interface ProgramRun {
  /** `repo@sha` of every source installed in the virtualenv the example runs with. */
  installed: string[];
  /** The example's program (example.py). */
  code: string;
  network: string;
  signal?: AbortSignal;
}

export type ProgramAnswer = { exitCode: number | null; stdout?: string; stderr?: string; durationMs?: number };

export class FakeSandbox implements SandboxClient {
  created = 0;
  destroyed = 0;
  createOptions: { timeoutMs: number; vcpus: number }[] = [];
  commands: (SandboxCommand & { network: string })[] = [];
  files: { path: string; content: string | Uint8Array }[] = [];
  networkChanges: string[] = [];
  /** Make `create` throw (a quota, no credentials on the platform). */
  failCreate?: string;
  /** Make `uv pip install` fail with this stderr. */
  failInstall?: string;
  network = 'allow-all';
  private venvs = new Map<string, string[]>();
  private lastExample = '';

  constructor(readonly program: (run: ProgramRun) => ProgramAnswer | Promise<ProgramAnswer> = () => ({ exitCode: 0, stdout: 'ok\n' })) {}

  /** Every string the sandbox was given: commands, arguments, environments, file contents (text). */
  everything(): string {
    const parts: string[] = [];
    for (const c of this.commands) parts.push(c.cmd, ...(c.args ?? []), c.cwd ?? '', ...Object.entries(c.env ?? {}).flat());
    for (const f of this.files) parts.push(f.path, typeof f.content === 'string' ? f.content : Buffer.from(f.content).toString('latin1'));
    return parts.join('\n');
  }

  async create(o: { timeoutMs: number; vcpus: number; signal?: AbortSignal }): Promise<SandboxVm> {
    this.created++;
    this.createOptions.push({ timeoutMs: o.timeoutMs, vcpus: o.vcpus });
    if (this.failCreate) throw new Error(this.failCreate);
    const done = (exitCode: number | null, stdout = '', stderr = '', durationMs?: number): SandboxCommandResult => ({
      exitCode,
      ...(durationMs !== undefined ? { durationMs } : {}),
      stdout: async () => stdout,
      stderr: async () => stderr,
    });
    return {
      runCommand: async (c) => {
        this.commands.push({ ...c, network: this.network });
        const args = c.args ?? [];
        if (c.cmd === 'bash' && args[0] === '-c' && args[1]?.includes('falkordb-local.sh start')) {
          return done(0, 'uv=/usr/local/bin/uv\nbin=/vercel/sandbox/.staleproof/falkordb/venv/lib/python3.12/site-packages/redislite/bin\n');
        }
        if (c.cmd === 'bash' && args[2] === 'unpack') return done(0, './pyproject.toml\n./docs/conf/setup.py\n');
        if (c.cmd === 'bash' && args[2] === 'flush') return done(0);
        if (c.cmd.endsWith('/uv') && args[0] === 'venv') return done(0);
        if (c.cmd.endsWith('/uv') && args[0] === 'pip') {
          if (this.failInstall) return done(1, '', this.failInstall);
          const python = args[args.indexOf('--python') + 1]!;
          const dirs = args.slice(args.indexOf('--python') + 2);
          this.venvs.set(python, dirs.map((d) => /\/src\/([^/]+?)__([^/]+?)@([0-9a-f]+)/.exec(d)!).map((m) => `${m[1]}/${m[2]}@${m[3]}`));
          return done(0);
        }
        if (c.cmd === 'env' && args[0] === '-i') {
          const python = args.find((a) => a.endsWith('/bin/python'))!;
          const a = await this.program({ installed: this.venvs.get(python) ?? [], code: this.lastExample, network: this.network, ...(c.signal ? { signal: c.signal } : {}) });
          return done(a.exitCode, a.stdout ?? '', a.stderr ?? '', a.durationMs);
        }
        return done(127, '', `fake sandbox: unexpected command ${c.cmd} ${args.join(' ')}`);
      },
      writeFiles: async (files) => {
        for (const f of files) {
          this.files.push(f);
          if (f.path.endsWith('/example.py')) this.lastExample = String(f.content);
        }
      },
      setNetwork: async (policy) => {
        this.network = policy;
        this.networkChanges.push(policy);
      },
      destroy: async () => {
        this.destroyed++;
      },
    };
  }
}

/** A traceback the way Python prints one. */
export function traceback(error: string): string {
  return `Traceback (most recent call last):\n  File "example.py", line 3, in <module>\n    print(greet("Ada"))\n${error}\n`;
}

/** A small gzipped tarball (contents do not matter: the fake sandbox never unpacks it). */
export const FAKE_TARBALL = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
