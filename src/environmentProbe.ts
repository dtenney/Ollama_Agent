/**
 * environmentProbe.ts
 *
 * Runs once on extension activation (or when context.md is >7 days stale) to
 * discover the local environment and write the facts to .ollamapilot/context.md.
 *
 * This gives every user — including public repo cloners — a populated context
 * file without manual editing. The agent reads it on every session so it never
 * has to re-discover tools, SSH hosts, OS details, etc.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { logInfo, logError } from './logger';

const execAsync = promisify(exec);

const STALE_DAYS = 7;
const CONTEXT_SECTION_MARKER = '<!-- ollamapilot:env-probe -->';

// ── Tool probing ───────────────────────────────────────────────────────────────

const TOOLS_TO_PROBE = [
    // Core
    'git', 'ssh', 'scp', 'sftp', 'curl', 'wget',
    // Runtimes
    'python', 'python3', 'node', 'npm', 'npx', 'pip', 'pip3',
    'ruby', 'go', 'rust', 'cargo', 'java', 'mvn', 'gradle',
    // Containers / infra
    'docker', 'docker-compose', 'kubectl', 'helm', 'terraform', 'ansible',
    // Security / recon
    'nmap', 'nc', 'netcat', 'wireshark', 'tshark', 'burpsuite',
    'sqlmap', 'ffuf', 'gobuster', 'hydra', 'john', 'hashcat',
    'msfconsole', 'msfvenom',
    // WSL / virtualisation
    'wsl',
];

async function probeTools(): Promise<{ name: string; path: string; version?: string }[]> {
    const found: { name: string; path: string; version?: string }[] = [];
    const isWin = process.platform === 'win32';
    const whichCmd = isWin ? 'where.exe' : 'which';

    await Promise.all(TOOLS_TO_PROBE.map(async (tool) => {
        try {
            const { stdout } = await execAsync(`${whichCmd} ${tool}`, { timeout: 3000 });
            const toolPath = stdout.split('\n')[0].trim(); // first result only
            if (!toolPath) { return; }

            // Try to get version for key tools
            let version: string | undefined;
            try {
                const versionFlags: Record<string, string> = {
                    git: '--version', ssh: '-V', python: '--version', python3: '--version',
                    node: '--version', npm: '--version', curl: '--version',
                    docker: '--version', kubectl: 'version --client --short',
                    nmap: '--version', go: 'version', cargo: '--version',
                };
                const flag = versionFlags[tool];
                if (flag) {
                    const { stdout: v, stderr: ve } = await execAsync(`${tool} ${flag}`, { timeout: 3000 });
                    const raw = (v || ve).split('\n')[0].trim();
                    // Extract just the version number if possible
                    const match = raw.match(/[\d]+\.[\d]+[\d.]*/);
                    version = match ? match[0] : raw.slice(0, 60);
                }
            } catch { /* version flag failed — still record the tool */ }

            found.push({ name: tool, path: toolPath, version });
        } catch { /* tool not found — skip */ }
    }));

    return found.sort((a, b) => a.name.localeCompare(b.name));
}

// ── SSH config parsing ─────────────────────────────────────────────────────────

interface SshHost {
    alias: string;
    hostname?: string;
    user?: string;
    identityFile?: string;
}

function parseSshConfig(): SshHost[] {
    const configPath = path.join(os.homedir(), '.ssh', 'config');
    const hosts: SshHost[] = [];
    try {
        const content = fs.readFileSync(configPath, 'utf8');
        let current: SshHost | null = null;
        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            const hostMatch = trimmed.match(/^Host\s+(.+)/i);
            if (hostMatch) {
                if (current) { hosts.push(current); }
                current = { alias: hostMatch[1].trim() };
                continue;
            }
            if (!current) { continue; }
            const hnMatch = trimmed.match(/^HostName\s+(.+)/i);
            if (hnMatch) { current.hostname = hnMatch[1].trim(); }
            const userMatch = trimmed.match(/^User\s+(.+)/i);
            if (userMatch) { current.user = userMatch[1].trim(); }
            const idMatch = trimmed.match(/^IdentityFile\s+(.+)/i);
            if (idMatch) { current.identityFile = idMatch[1].trim(); }
        }
        if (current) { hosts.push(current); }
    } catch { /* no ssh config */ }
    return hosts;
}

function listSshKeys(): string[] {
    const sshDir = path.join(os.homedir(), '.ssh');
    try {
        return fs.readdirSync(sshDir)
            .filter(f => !f.endsWith('.pub') && !['config', 'known_hosts', 'known_hosts.old', 'authorized_keys'].includes(f))
            .sort();
    } catch { return []; }
}

// ── WSL distros ────────────────────────────────────────────────────────────────

async function probeWsl(): Promise<string[]> {
    if (process.platform !== 'win32') { return []; }
    try {
        const { stdout } = await execAsync('wsl --list --quiet', { timeout: 5000 });
        return stdout.split('\n')
            .map(l => l.replace(/\0/g, '').trim())  // WSL outputs UTF-16 with null bytes
            .filter(Boolean);
    } catch { return []; }
}

// ── OS info ────────────────────────────────────────────────────────────────────

async function probeOs(): Promise<string> {
    const platform = process.platform;
    const arch = process.arch;
    const nodeVer = process.version;

    if (platform === 'win32') {
        try {
            const { stdout } = await execAsync(
                'powershell -NoProfile -Command "(Get-CimInstance Win32_OperatingSystem).Caption + \' \' + (Get-CimInstance Win32_OperatingSystem).Version"',
                { timeout: 5000 }
            );
            return `${stdout.trim()} (${arch})`;
        } catch {
            return `Windows ${arch}`;
        }
    } else if (platform === 'darwin') {
        try {
            const { stdout } = await execAsync('sw_vers -productVersion', { timeout: 3000 });
            return `macOS ${stdout.trim()} (${arch})`;
        } catch { return `macOS (${arch})`; }
    } else {
        try {
            const { stdout } = await execAsync('uname -a', { timeout: 3000 });
            return stdout.trim();
        } catch { return `Linux (${arch})`; }
    }
}

// ── Network / IP ───────────────────────────────────────────────────────────────

async function probeLocalIp(): Promise<string> {
    const ifaces = os.networkInterfaces();
    const addrs: string[] = [];
    for (const [name, entries] of Object.entries(ifaces)) {
        for (const e of entries ?? []) {
            if (e.family === 'IPv4' && !e.internal && !e.address.startsWith('169.')) {
                addrs.push(`${e.address} (${name})`);
            }
        }
    }
    return addrs.slice(0, 4).join(', ') || 'unknown';
}

// ── context.md generation ──────────────────────────────────────────────────────

function formatContextSection(data: {
    osInfo: string;
    localIp: string;
    tools: { name: string; path: string; version?: string }[];
    sshHosts: SshHost[];
    sshKeys: string[];
    wslDistros: string[];
}): string {
    const now = new Date().toISOString().slice(0, 10);

    const toolLines = data.tools.length > 0
        ? data.tools.map(t => `- ${t.name}${t.version ? ` (${t.version})` : ''} — ${t.path}`).join('\n')
        : '- (none detected)';

    const notFound = TOOLS_TO_PROBE.filter(t => !data.tools.find(f => f.name === t));
    const notFoundLine = notFound.length > 0 ? `\nNot installed: ${notFound.join(', ')}` : '';

    const sshHostLines = data.sshHosts.length > 0
        ? data.sshHosts.map(h => {
            const parts = [`- ${h.alias}`];
            if (h.hostname && h.hostname !== h.alias) { parts.push(`→ ${h.hostname}`); }
            if (h.user) { parts.push(`user: ${h.user}`); }
            if (h.identityFile) { parts.push(`key: ${h.identityFile}`); }
            return parts.join(', ');
        }).join('\n')
        : '- (no SSH config found)';

    const keyLines = data.sshKeys.length > 0
        ? data.sshKeys.map(k => `- ${k}`).join('\n')
        : '- (no keys found)';

    const wslLine = data.wslDistros.length > 0
        ? `WSL distros available: ${data.wslDistros.join(', ')}`
        : 'WSL: not available or no distros installed';

    return `${CONTEXT_SECTION_MARKER}
<!-- Auto-generated by OllamaPilot environment probe on ${now}. Do not edit this section manually — it will be regenerated. Edit the sections above/below instead. -->

## Local environment (auto-detected ${now})

### OS
${data.osInfo}
Local IP: ${data.localIp}
${wslLine}

### Available CLI tools
${toolLines}
${notFoundLine}

### SSH
**Configured hosts (~/.ssh/config):**
${sshHostLines}

**Keys (~/.ssh/):**
${keyLines}

**Usage:** ssh <alias or IP>, scp for file transfer. Default key: id_ed25519 if present, else id_rsa.
<!-- end:ollamapilot:env-probe -->`;
}

// ── Staleness check ────────────────────────────────────────────────────────────

function isStale(contextPath: string): boolean {
    try {
        const content = fs.readFileSync(contextPath, 'utf8');
        const match = content.match(/Auto-generated by OllamaPilot environment probe on (\d{4}-\d{2}-\d{2})/);
        if (!match) { return true; } // never probed
        const probeDate = new Date(match[1]);
        const ageDays = (Date.now() - probeDate.getTime()) / (1000 * 60 * 60 * 24);
        return ageDays >= STALE_DAYS;
    } catch {
        return true; // file doesn't exist — probe needed
    }
}

// ── Main entry point ───────────────────────────────────────────────────────────

export async function ensureEnvironmentContext(workspaceRoot: string): Promise<void> {
    const ollamapilotDir = path.join(workspaceRoot, '.ollamapilot');
    const contextPath = path.join(ollamapilotDir, 'context.md');

    if (!isStale(contextPath)) {
        logInfo('[env-probe] context.md is fresh — skipping probe');
        return;
    }

    logInfo('[env-probe] Probing local environment...');

    try {
        // Ensure .ollamapilot/ exists
        if (!fs.existsSync(ollamapilotDir)) {
            fs.mkdirSync(ollamapilotDir, { recursive: true });
        }

        // Run all probes in parallel
        const [osInfo, localIp, tools, wslDistros] = await Promise.all([
            probeOs(),
            probeLocalIp(),
            probeTools(),
            probeWsl(),
        ]);
        const sshHosts = parseSshConfig();
        const sshKeys = listSshKeys();

        const envSection = formatContextSection({ osInfo, localIp, tools, sshHosts, sshKeys, wslDistros });

        // Read existing context.md (if any) and replace/append the env section
        let existing = '';
        try { existing = fs.readFileSync(contextPath, 'utf8'); } catch { /* new file */ }

        let updated: string;
        const startMarker = existing.indexOf(CONTEXT_SECTION_MARKER);
        const endMarker = existing.indexOf('<!-- end:ollamapilot:env-probe -->');

        if (startMarker !== -1 && endMarker !== -1) {
            // Replace existing env section
            updated = existing.slice(0, startMarker) + envSection + existing.slice(endMarker + '<!-- end:ollamapilot:env-probe -->'.length);
        } else if (startMarker !== -1) {
            // Partial marker — replace from start marker to end of file
            updated = existing.slice(0, startMarker) + envSection;
        } else if (existing.trim()) {
            // Append to existing user-written content
            updated = existing.trimEnd() + '\n\n' + envSection;
        } else {
            // New file — write a minimal header + env section
            updated = `# Project Context\n\n_Add project-specific context, goals, conventions, and rules of engagement above this line._\n_The section below is auto-managed by OllamaPilot._\n\n${envSection}`;
        }

        fs.writeFileSync(contextPath, updated, 'utf8');
        logInfo(`[env-probe] context.md updated (${tools.length} tools, ${sshHosts.length} SSH hosts)`);
    } catch (err) {
        logError(`[env-probe] Failed: ${err}`);
    }
}
