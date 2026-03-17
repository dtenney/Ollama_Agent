import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TieredMemoryManager } from './memoryCore';
import { getConfig } from './config';
import { streamChatRequest } from './ollamaClient';
import { logInfo, logError, logWarn } from './logger';

/** Files to scan in priority order. First match wins per category. */
const DOC_SOURCES: Array<{ glob: string; category: string; maxSize: number }> = [
    // User-curated context file (highest priority)
    { glob: '.ollamapilot/context.md', category: 'context', maxSize: 128_000 },
    { glob: '.ollamapilot/context.txt', category: 'context', maxSize: 128_000 },
    // Project docs (generous limits — content is chunked before sending to model)
    { glob: 'README.md', category: 'readme', maxSize: 256_000 },
    { glob: 'CONTRIBUTING.md', category: 'contributing', maxSize: 128_000 },
    // Package manifests
    { glob: 'package.json', category: 'manifest', maxSize: 64_000 },
    { glob: 'requirements.txt', category: 'manifest', maxSize: 32_000 },
    { glob: 'pyproject.toml', category: 'manifest', maxSize: 64_000 },
    { glob: 'Cargo.toml', category: 'manifest', maxSize: 32_000 },
    { glob: 'go.mod', category: 'manifest', maxSize: 32_000 },
    { glob: 'Gemfile', category: 'manifest', maxSize: 32_000 },
    { glob: 'pom.xml', category: 'manifest', maxSize: 64_000 },
    // Infrastructure
    { glob: 'docker-compose.yml', category: 'infra', maxSize: 32_000 },
    { glob: 'docker-compose.yaml', category: 'infra', maxSize: 32_000 },
    { glob: 'Dockerfile', category: 'infra', maxSize: 16_000 },
    { glob: '.env.example', category: 'infra', maxSize: 8_000 },
    { glob: 'Makefile', category: 'infra', maxSize: 16_000 },
];

const EXTRACTION_PROMPT = `You are a strict fact extractor for a coding assistant's memory. Given a project document excerpt, extract ONLY facts that would help a developer BUILD, TEST, DEPLOY, or MAINTAIN this codebase. Output one JSON object per line (JSONL format). No other text.

Each line must be exactly: {"tier": N, "content": "...", "tags": ["..."]}

Tier rules:
- tier 0: Server IPs/hostnames with specific addresses, database connection strings, important project paths on the server, log file paths, system users/credentials
- tier 1: Build commands, test commands, deploy commands, database access commands (actual shell commands only)
- tier 3: Coding conventions, security requirements, compliance requirements, important business rules

DO NOT extract:
- Project descriptions, feature lists, marketing text, changelogs, version history
- Individual API endpoint routes (there are too many — only extract the BASE URL if present)
- License, Code of Conduct, badges, shield URLs
- Links to GitHub, npm, PyPI, documentation sites, marketplace
- Generic installation instructions ("install Node.js", "install Ollama")
- How-to-contribute boilerplate (fork, PR process)
- Configuration property descriptions from package.json
- Individual dependency version lines from requirements.txt or package.json
- Code snippets, import statements, class/function definitions
- Troubleshooting steps or symptoms ("paper jam", "no video", "garbled output")
- Hardware specs (MTBF, voltage, response times) unless they are configuration values
- Vague quality assessments ("professional architecture", "strong security", "excellent docs")
- Acceptance criteria, test checklists, deployment checklists
- Data counts or statistics ("222 materials", "90 tables", "2000+ businesses", "281 tests")
- Physical maintenance procedures (cleaning, safety, calibration)
- Bug fix history ("issue fixed", "function added", "listener added")
- Future enhancements or roadmap items
- Obvious statements ("requires network connection", project name)
- Anything a developer would already know from reading the code
- If you find NOTHING worth extracting, output ZERO lines — do NOT output "No specific X" or "No commands provided" entries

Rules:
- Maximum 5 entries per excerpt — ONLY the most unique, actionable facts
- Each entry must be a SPECIFIC, CONCRETE fact — not a category label
- Each entry under 100 characters
- Only extract what you are CERTAIN is a real project fact
- When in doubt, DO NOT extract
- If the text is mostly prose/marketing/changelogs/API routes, return ZERO entries

Now extract facts from this excerpt:
`;

/** Max linked docs to follow from README/other docs */
const MAX_LINKED_DOCS = 20;

/** Max size for linked docs (128KB) */
const LINKED_DOC_MAX_SIZE = 128_000;

/** Skip linked docs matching these filename patterns (implementation artifacts, not reference) */
const LINKED_DOC_SKIP_PATTERNS: RegExp[] = [
    /archive\//i,
    /_PLAN\.md$/i,
    /_COMPLETE[D]?\.md$/i,
    /_SUMMARY\.md$/i,
    /_FIX\.md$/i,
    /_IMPLEMENTATION\.md$/i,
    /_IMPLEMENTATION_SUMMARY\.md$/i,
    /_IMPLEMENTATION_COMPLETE\.md$/i,
    /CONSOLIDATION/i,
    /CLEANUP/i,
    /REVIEW_PLAN/i,
    /FINAL_STATUS/i,
    /FINAL_TEST_RESULTS/i,
    /CRITICAL_FIXES/i,
];

/**
 * Extract relative markdown links to local docs from content.
 * Matches patterns like [text](docs/FILE.md) and [text](SOME_FILE.md).
 */
function extractLinkedDocs(content: string, root: string): string[] {
    const links: string[] = [];
    const seen = new Set<string>();
    // Match markdown links: [text](path)
    const re = /\]\(([^)]+\.md)\)/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
        let relPath = match[1];
        // Skip external URLs
        if (relPath.startsWith('http://') || relPath.startsWith('https://')) { continue; }
        // Strip anchor fragments
        relPath = relPath.split('#')[0];
        if (!relPath) { continue; }
        // Normalize path separators
        relPath = relPath.replace(/\//g, path.sep);
        const normalized = relPath.toLowerCase();
        if (seen.has(normalized)) { continue; }
        // Skip noise filenames
        if (LINKED_DOC_SKIP_PATTERNS.some(p => p.test(relPath))) { continue; }
        // Verify file exists
        const fullPath = path.join(root, relPath);
        if (fs.existsSync(fullPath)) {
            seen.add(normalized);
            links.push(relPath);
        }
    }
    return links;
}

/** Chunk size target for splitting large documents */
const CHUNK_TARGET_CHARS = 4_000;

/**
 * Split document content into chunks on paragraph boundaries.
 * Tries to break on markdown headers (## / ###) or double newlines.
 * Small docs (<=CHUNK_TARGET_CHARS) return as a single chunk.
 */
function splitIntoChunks(content: string): string[] {
    if (content.length <= CHUNK_TARGET_CHARS) { return [content]; }

    const chunks: string[] = [];
    let remaining = content;

    while (remaining.length > 0) {
        if (remaining.length <= CHUNK_TARGET_CHARS) {
            chunks.push(remaining);
            break;
        }

        // Look for a good split point within the target range
        const searchRegion = remaining.slice(0, CHUNK_TARGET_CHARS);

        // Prefer splitting on markdown headers (## at start of line)
        let splitIdx = -1;
        const headerMatch = searchRegion.match(/\n(?=##\s)/g);
        if (headerMatch) {
            // Find the LAST header boundary within the region
            let lastPos = 0;
            let match: RegExpExecArray | null;
            const re = /\n(?=##\s)/g;
            while ((match = re.exec(searchRegion)) !== null) {
                if (match.index > CHUNK_TARGET_CHARS * 0.3) { // Don't split too early
                    lastPos = match.index;
                }
            }
            if (lastPos > 0) { splitIdx = lastPos; }
        }

        // Fallback: split on double newline
        if (splitIdx === -1) {
            const lastDoubleNl = searchRegion.lastIndexOf('\n\n');
            if (lastDoubleNl > CHUNK_TARGET_CHARS * 0.3) {
                splitIdx = lastDoubleNl;
            }
        }

        // Last resort: split on any newline
        if (splitIdx === -1) {
            const lastNl = searchRegion.lastIndexOf('\n');
            splitIdx = lastNl > 0 ? lastNl : CHUNK_TARGET_CHARS;
        }

        chunks.push(remaining.slice(0, splitIdx).trim());
        remaining = remaining.slice(splitIdx).trim();
    }

    return chunks.filter(c => c.length > 50); // Drop tiny trailing fragments
}

/** Post-extraction filter: reject entries matching these patterns */
export const GARBAGE_PATTERNS: RegExp[] = [
    // External URLs / links
    /marketplace\.visualstudio/i,
    /github\.com/i,
    /stackoverflow/i,
    /npmjs\.com/i,
    /pypi\.org/i,
    /ollama\.com/i,
    /contributor.covenant/i,
    /conventionalcommits\.org/i,
    /code\.visualstudio\.com/i,
    // Boilerplate / meta
    /code.of.conduct/i,
    /\blicense\b/i,
    /\bbadge\b/i,
    /\bshield\b/i,
    /github.discussions/i,
    /help.*about/i,
    /--version/i,
    /configuration.property/i,
    /activation.event/i,
    /keybinding/i,
    /first.time.setup/i,
    /getting.started/i,
    /thank.*contribut/i,
    /welcome.*contribut/i,
    /open.an?.issue/i,
    /open.a?.pull.request/i,
    /star.the.repo/i,
    /spread.the.word/i,
    // Marketing / feature descriptions / project descriptions
    /no.cloud/i,
    /^the\s+\w+\s+management\s+system\s+handles/i,
    /no.subscriptions/i,
    /no.telemetry/i,
    /100%.(?:private|offline|free|local)/i,
    /\boffline\b.*\bonline\b/i,
    /\bpowered.by\b/i,
    /\bfeature[s]?:/i,
    /\bcan attach\b/i,
    /\bcan be used\b/i,
    /\blets you\b/i,
    /\ballows you\b/i,
    /\bsupports?\b.*\bfiles?\b/i,
    /\battach.*files?.*message/i,
    /\b@filename\b/i,
    /\b@file\b.*mention/i,
    // Keyboard shortcuts described in prose
    /ctrl\+shift/i,
    /cmd\+shift/i,
    /alt\+[a-z]/i,
    // Default localhost URLs that aren't project-specific
    /localhost:\d{4}/i,
    /127\.0\.0\.1/i,
    // Extension URIs
    /^vscode:\/\//i,
    /\bvscode:\/\//i,
    // Generic install/setup commands
    /\bollama\s+serve\b/i,
    /\bollama\s+pull\b/i,
    /\bollama\s+list\b/i,
    /\binstall.*ollama/i,
    /\bollama.*install/i,
    /\binstall.*homebrew/i,
    /\bhomebrew/i,
    /\bcode\s+--install-extension\b/i,
    /\bnpm\s+install$/i,
    /\bpip\s+install$/i,
    /install.*from.*vsix/i,
    /install.*vsix/i,
    /install.*via/i,
    /install.*command.palette/i,
    /\bgit\s+clone\b/i,
    /\bgit\s+checkout\b/i,
    /\bgit\s+push\b/i,
    /\bgit\s+commit\b/i,
    /fork.*repositor/i,
    /clone.*repositor/i,
    // Too-short or single-word entries (just a filename or tool name)
    /^[\w.-]+$/,
    // VS Code view/command IDs and extension metadata
    /^ollamaAgent\./i,
    /ollamaAgent\.[a-zA-Z]/i,
    /\.chatView/i,
    /\.memoryView/i,
    /\bextension.?version\b/i,
    /\bpublisher\b/i,
    /\bdisplayName\b/i,
    // Config property descriptions
    /\buse.*ollamaAgent\./i,
    /\bauto.include/i,
    // Internal build details (redundant with npm run build)
    /\bnode\s+esbuild/i,
    /\besbuild\.js\b/i,
    // Trivial file organization
    /\bstore.*in.*directory/i,
    /\bicons?.*directory/i,
    /\/images\s+directory/i,
    // Version requirements (not actionable)
    /\bversion\s*[><=]+/i,
    /\bversion\s+\d/i,
    /\b[Vv][Ss]\s*[Cc]ode\s+version/i,
    // Generic advice / obvious statements
    /store.*configuration/i,
    /settings\.json/i,
    /\bprerequisite/i,
    /\brequired.*installed/i,
    /\binstalled.*required/i,
    /\binstall.*locally/i,
    /\binstalled.*locally/i,
    /\binstalled.*running/i,
    /\bneeds?\s+to\s+be\s+installed/i,
    /\bshould\s+be\s+installed/i,
    /\bmust\s+be\s+installed/i,
    /\bor\s+later\s*$/i,
    /\bor\s+above\s*$/i,
    // PR / contribution process
    /\bPR\s+checklist/i,
    /\bpull\s+request/i,
    /\bsubmit.*PR/i,
    /\bbranch.*from.*main/i,
    /\bfeature\//i,
    /\bfix\//i,
    // Bug report templates
    /\bsteps\s+to\s+reproduce/i,
    /\bexpected\s+behavio/i,
    /\bactual\s+behavio/i,
    /\breporting\s+bugs/i,
    // Individual dependency version lines (belongs in requirements.txt/package.json, not memory)
    /^[a-z][a-z0-9._-]*[><=!~]=*\d/i,
    /^[a-z][a-z0-9._-]*==\d/i,
    // npm lifecycle hooks (not real build commands)
    /\bnpm\s+run\s+prepare\b/i,
    /\bnpm\s+run\s+prepublish/i,
    /\bnpm\s+run\s+postinstall/i,
    /\bnpm\s+run\s+preinstall/i,
    // "No specific X" / "not specified" / "none found" / "no commands" / "no X listed" entries (model saying it found nothing)
    /^no\s+specific\b/i,
    /^no\s+(?:server|database|project|log|api|important|system|build|test|deploy|coding)\b/i,
    /\bnot\s+(?:specified|provided|mentioned|listed)\.{0,3}$/i,
    /^none\s+(?:found|mentioned|specified|listed)/i,
    /\bnone\s+mentioned\.{0,3}$/i,
    /commands\s+provided\.{0,3}$/i,
    /\blisted\.{0,3}$/i,
    // Bare API route paths (not actionable without context)
    /^\/[a-z][a-z0-9/_{}\-<>]*\.{0,3}$/i,
    /^\/\w+\/api\//i,
    // Vague quality/status labels (not actionable)
    /^(?:professional|strong|excellent|solid|clean|comprehensive|thorough)\s+\w+/i,
    /^(?:security|operational|domain).specific/i,
    /^(?:code cleanup|test organization|health endpoints)\b/i,
    /\bsuitable for\b/i,
    /\bexceeds?\s+(?:industry|standard)/i,
    /\broom\s+for\s+(?:expansion|improvement)/i,
    /\bwith\s+documented\s+audit/i,
    // Model parroting the prompt tier descriptions back
    /^(?:server\s+IPs|build\s+commands|test\s+commands|deploy\s+commands|database\s+access\s+commands)\b/i,
    // Troubleshooting symptoms (not infrastructure facts)
    /^(?:no weight|unstable|connection timeout|no printing|garbled|paper jam|no video|poor image|authentication failed|items cut off|black bars|large receipt)/i,
    // Hardware specs / physical maintenance / physical features (not dev-actionable)
    /\bMTBF\b/i,
    /\b\d+V\s+(?:or|voltage)/i,
    /[<>]\d+ms\b/i,
    /\b\d+-\d+ms\b.*(?:mechanical|response)/i,
    /\b>99%\b/i,
    /\bend-to-end\b/i,
    /\b\d{3},?\d{3}\+?\s+operations\b/i,
    /\bcleaning\s+procedure/i,
    /\belectrical\s+safety/i,
    /\blens\s+cleaning/i,
    /\bcalibration\b/i,
    /\bmanual\s+release\s+key/i,
    /\bproper\s+grounding/i,
    /\bmanufacturer\s+safety/i,
    // Generic monitoring/metric labels
    /^(?:database query count|network requests|image sizes|memory leaks|cache size|large object|database connection pool|response payload|APM integration|query analytics|real user monitoring|resource monitoring)\.{0,3}$/i,
    // Code-readable implementation details (developer would see in code)
    /^(?:creates?|applies)\s+(?:refund|customer|discount)/i,
    /^expected\s+amount\s+calculation/i,
    // Code snippets / patterns / decorators
    /^(?:import|from|const|let|var|def|class)\s+/i,
    /^@\w+/i,
    /^try-except\b/i,
    /\brequire\s*\(/i,
    /\.configure\(\s*\.\.\./i,
    /\.configure\(\)/i,
    /\.init_app\(/i,
    /\.build\(\{/i,
    /\bdb\.session\.query\b/i,
    /\bfunc\.count\b/i,
    /\bdocument\.getElementById\b/i,
    /\.query\.paginate\(/i,
    /\bemit\s*\(/i,
    /^structlog\./i,
    // Generic checklist items / testing checklists
    /^(?:ensure|verify|test|check)\s+(?:recent|complete|user|concurrent|logo|opening|closing|network|hardware)/i,
    /\btesting\s+checklist\b/i,
    /\bprevention\s+guidelines\b/i,
    /\bdeployment\s+checklist\b/i,
    // Moved/created file entries (implementation history, not reference)
    /^(?:moved|created)\s+/i,
    /^(?:implemented)\s+\/\w/i,
    // Dependencies listed as facts
    /^dependencies\s+listed/i,
    // Placeholder/template entries
    /\[Phone\]/i,
    /\[Email\]/i,
    /\[Support\s+Number\]/i,
    // Bare file paths without context (just a path, not actionable)
    /^app\/[\w/.]+\.{0,3}$/i,
    /^\/app\/[\w/.]+\.{0,3}$/i,
    // Generic "X required" / "X implemented" without specifics
    /^(?:user authentication|role-based access|input validation|regular security|customer consent)\b.*\b(?:required|implemented|reviews)\.{0,3}$/i,
    // Redundant security phrases (already captured once from README)
    /^(?:PII encryption|secure photo storage|path traversal protection|XSS protection|secure file handling|access control implementation|audit logging implemented|data retention policies|secure deletion|staff training|incident response|breach notification|data portability|right to deletion)\.{0,3}$/i,
    // "Review and update" / generic improvement tasks
    /^review\s+and\s+update\b/i,
    /^review\s+(?:JavaScript|slow query|network)/i,
    /^add\s+pagination\b/i,
    /^check\s+(?:database|image|missing)/i,
    // Vague short status/label entries (< 4 words, ends with ...)
    /^[\w\s]{5,30}\.{3}$/,
    // Generic monitoring/alert labels
    /^(?:failed|storage|recovery|data loss|system availability)\s+\w+\.{0,3}$/i,
    // Feature descriptions disguised as conventions
    /\benhancement\s+system\b/i,
    /\bfor\s+comprehensive\s+analytic/i,
    /\bfor\s+improved\s+user\s+experience/i,
    // "Server hostname: localhost" (not a real server)
    /\bhostname:\s*localhost/i,
    // "Industry standards" / vague compliance
    /^industry\s+standards\b/i,
    /^full\s+accountability\b/i,
    // Placeholder contact info / vague contact references
    /\[Contact\s+Information\]/i,
    /^emergency\s+contact\s+information\b/i,
    /^budget\s+considerations\b/i,
    // Placeholder paths / example values
    /\/path\/to\//i,
    /your-secret-key/i,
    /your-dsn@/i,
    // Vague category labels without specifics
    /^database\s+connection\s+strings?\.{0,3}$/i,
    /^database\s+connection\s+string\s+needed/i,
    /^customer\s+interactions\.{0,3}$/i,
    /^auto-reconnection\b/i,
    /^drawer\s+operations\s+by\b/i,
    /^transaction_items\s*->/i,
    /^storage\s+capacity\s+alerts/i,
    /^recovery\s+time\s+tracking/i,
    /^session\s+management\s+and/i,
    /^material.level\s+margin/i,
    /^real.time\s+(?:transaction|dashboard)\s+monitoring/i,
    /^monitoring\s+points\s+include/i,
    /^mobile.friendly\s+design/i,
    // Vague "X easier" / "X management" / "X application" labels
    /\bdebugging\s+easier/i,
    /\bless\s+code\s+to\s+maintain/i,
    // Feature descriptions via route ("daily snapshot via /route")
    /\bvia\s+\/\w/i,
    // Vague SLA / metric targets without config details
    /^system\s+uptime/i,
    /^RTO\s+targets/i,
    /\bfuel\s+per\s+ton\b/i,
    /\befficiency\s+monitoring/i,
    // Bare endpoint paths with HTTP method (individual API routes)
    /^(?:GET|POST|PUT|DELETE|PATCH)\s+\/[\w/{}<>.-]+/i,
    // Generic "handles/manages/controls" descriptions (code-readable)
    /^\w+\/\w+\.py\s+(?:handles|manages|controls)\b/i,
    /\btest.endpoint\b/i,
    // Vague "enhanced/improved X" without specifics
    /^enhanced\s+\w+\s+(?:system|workflow)\b/i,
    // Data counts / statistics (not actionable)
    /^\d+\+?\s+(?:materials|businesses|tables|tests|files|documents|endpoints|routes)\b/i,
    /^\d+\+?\s+\w+\s+(?:with|covering|passing)\b/i,
    // Implementation history / bug fix history
    /\bissue\s+fixed\.{0,3}$/i,
    /\bfunction\s+added\.{0,3}$/i,
    /\blistener\s+(?:for|added)\.{0,3}$/i,
    /\bhelper\s+function\s+added/i,
    /\bcleanup\s+helper/i,
    /\b-\s+Added\s+`/i,
    // Future enhancements / roadmap
    /\bfuture\s+enhance/i,
    /\bplanned\s+feature/i,
    // Obvious / tautological statements
    /^requires\s+(?:stable|reliable)\s+(?:network|internet)/i,
    /^(?:scrap\s+yard|management\s+system)\.{0,3}$/i,
    /^network\s+dependency/i,
    // Project name as a fact
    /^scrap\s+yard\s+management/i,
    // Vague "X present" / "X configured" / "X complete" without details
    /\bfields?\s+present\.{0,3}$/i,
    /\bconfigured\.{0,3}$/i,
    /^core\s+functionality\s+complete/i,
    /^transaction\s+integrity\s+and\b/i,
    // Obvious from reading code / manifest files directly
    /^eslint\s+for\b/i,
    /^postgresql\s+with\s+sqlalchemy/i,
    /^ensure\s+sqlalchemy\s+is\s+properly/i,
    /\bversion\s+must\s+be\s+compatible/i,
    // Generic single-concept security/compliance restatements
    /^(?:implemented comprehensive|standardized error|secure token-based|regular security audits|regular penetration|regular reconciliation|graceful degradation|error handling on all|permission checks on all)\b/i,
    /^sql\s+injection\s+prevention\.{0,3}$/i,
    /^enhanced\s+file\s+upload\s+validation\.{0,3}$/i,
    /^regularly\s+review\s+user\s+permissions\.{0,3}$/i,
    /^enhanced\s+\w+\s+(?:protection|implementation|monitoring)\.{0,3}$/i,
    /^enhanced\s+\w+\s+(?:protection|implementation|monitoring|health)\b/i,
    /^complete\s+audit\s+trails?\b/i,
    /^security\s+controls?:\s+comprehensive/i,
    /^compliance\s+with\s+financial\s+regulations\.{0,3}$/i,
    /^implement\s+automated\s+vulnerability/i,
];

interface ExtractedFact {
    tier: 0 | 1 | 2 | 3;
    content: string;
    tags: string[];
}

/**
 * Parse JSONL output from the model into structured facts.
 * Tolerant of extra text, markdown fences, etc.
 */
function parseExtractedFacts(raw: string): ExtractedFact[] {
    const facts: ExtractedFact[] = [];
    // Strip markdown code fences if present
    const cleaned = raw.replace(/```(?:json|jsonl)?\s*/gi, '').replace(/```/g, '');
    const lines = cleaned.split('\n');

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) { continue; }
        try {
            const parsed = JSON.parse(trimmed);
            if (
                typeof parsed.tier === 'number' &&
                parsed.tier >= 0 && parsed.tier <= 3 &&
                typeof parsed.content === 'string' &&
                parsed.content.trim().length >= 20
            ) {
                facts.push({
                    tier: parsed.tier as 0 | 1 | 2 | 3,
                    content: parsed.content.trim().slice(0, 500),
                    tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
                });
            }
        } catch {
            // Not valid JSON, skip
        }
    }
    return facts;
}

/**
 * Scan project documentation and extract structured facts into memory.
 * Uses the configured Ollama model to understand document content.
 */
export async function scanProjectDocs(memoryManager: TieredMemoryManager): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
        vscode.window.showWarningMessage('No workspace folder open.');
        return;
    }

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Scanning project docs…', cancellable: true },
        async (progress, token) => {
            // 1. Find which docs exist
            progress.report({ message: 'Finding documentation files…' });
            const foundDocs: Array<{ path: string; category: string; content: string }> = [];

            for (const source of DOC_SOURCES) {
                const fullPath = path.join(root, source.glob);
                if (!fs.existsSync(fullPath)) { continue; }
                try {
                    const stat = fs.statSync(fullPath);
                    if (stat.size > source.maxSize) {
                        logInfo(`[doc-scan] Skipping ${source.glob} (${stat.size} bytes > ${source.maxSize} limit)`);
                        continue;
                    }
                    const content = fs.readFileSync(fullPath, 'utf8');
                    foundDocs.push({ path: source.glob, category: source.category, content });
                } catch (err) {
                    logWarn(`[doc-scan] Error reading ${source.glob}: ${(err as Error).message}`);
                }
            }

            if (foundDocs.length === 0) {
                vscode.window.showInformationMessage(
                    'No documentation files found. Create .ollamapilot/context.md with project facts for best results.'
                );
                return;
            }

            logInfo(`[doc-scan] Found ${foundDocs.length} doc(s): ${foundDocs.map(d => d.path).join(', ')}`);

            // 1b. Follow markdown links from discovered docs to find linked documentation
            const alreadyQueued = new Set(foundDocs.map(d => d.path.toLowerCase()));
            const linkedPaths: string[] = [];
            for (const doc of foundDocs) {
                if (doc.path.endsWith('.md')) {
                    const links = extractLinkedDocs(doc.content, root);
                    for (const link of links) {
                        if (alreadyQueued.has(link.toLowerCase())) { continue; }
                        if (linkedPaths.length >= MAX_LINKED_DOCS) { break; }
                        alreadyQueued.add(link.toLowerCase());
                        linkedPaths.push(link);
                    }
                }
                if (linkedPaths.length >= MAX_LINKED_DOCS) { break; }
            }

            // Read linked docs and add to queue
            for (const relPath of linkedPaths) {
                const fullPath = path.join(root, relPath);
                try {
                    const stat = fs.statSync(fullPath);
                    if (stat.size > LINKED_DOC_MAX_SIZE) {
                        logInfo(`[doc-scan] Skipping linked ${relPath} (${stat.size} bytes > ${LINKED_DOC_MAX_SIZE} limit)`);
                        continue;
                    }
                    const content = fs.readFileSync(fullPath, 'utf8');
                    foundDocs.push({ path: relPath, category: 'linked', content });
                } catch (err) {
                    logWarn(`[doc-scan] Error reading linked ${relPath}: ${(err as Error).message}`);
                }
            }

            if (linkedPaths.length > 0) {
                logInfo(`[doc-scan] Following ${linkedPaths.length} linked doc(s): ${linkedPaths.join(', ')}`);
            }

            // 2. Get existing memory for deduplication
            const existingContent = new Set<string>();
            for (let tier = 0; tier <= 5; tier++) {
                const entries = await memoryManager.listByTier(tier);
                for (const e of entries) {
                    existingContent.add(e.content.toLowerCase());
                }
            }

            // 3. Extract facts from each doc using the model
            const model = getConfig().model;
            const totalDocs = foundDocs.length;
            let totalIngested = 0;
            let totalSkipped = 0;

            logInfo(`[doc-scan] Total docs to process: ${totalDocs} (${totalDocs - linkedPaths.length} primary + ${linkedPaths.length} linked)`);

            for (let i = 0; i < foundDocs.length; i++) {
                if (token.isCancellationRequested) { break; }

                const doc = foundDocs[i];
                progress.report({
                    message: `Extracting from ${doc.path} (${i + 1}/${totalDocs})…`,
                    increment: (80 / totalDocs),
                });

                try {
                    // Split large docs into chunks for better extraction
                    const chunks = splitIntoChunks(doc.content);
                    const allDocFacts: ExtractedFact[] = [];

                    for (let c = 0; c < chunks.length; c++) {
                        if (token.isCancellationRequested) { break; }

                        const chunkLabel = chunks.length > 1 ? ` chunk ${c + 1}/${chunks.length}` : '';
                        progress.report({
                            message: `Extracting from ${doc.path}${chunkLabel} (${i + 1}/${foundDocs.length})…`,
                        });

                        let response = '';
                        await streamChatRequest(
                            model,
                            [
                                { role: 'system', content: 'You are a precise fact extractor. Output ONLY JSONL lines, no other text.' },
                                { role: 'user', content: EXTRACTION_PROMPT + chunks[c] },
                            ],
                            [],
                            (t) => { response += t; },
                            { stop: false },
                        );

                        const chunkFacts = parseExtractedFacts(response)
                            .filter(f => !GARBAGE_PATTERNS.some(p => p.test(f.content)))
                            .slice(0, 8); // Per-chunk quality cap
                        allDocFacts.push(...chunkFacts);
                    }

                    // Deduplicate near-matches across all chunks
                    const uniqueFacts: ExtractedFact[] = [];
                    for (const fact of allDocFacts) {
                        const normalized = fact.content.toLowerCase().replace(/[^a-z0-9]/g, '');
                        const isDupe = uniqueFacts.some(existing => {
                            const existNorm = existing.content.toLowerCase().replace(/[^a-z0-9]/g, '');
                            return existNorm.includes(normalized) || normalized.includes(existNorm);
                        });
                        if (!isDupe) { uniqueFacts.push(fact); }
                    }

                    logInfo(`[doc-scan] ${doc.path}: ${chunks.length} chunk(s), ${uniqueFacts.length} facts after dedup`);

                    for (const fact of uniqueFacts) {
                        if (token.isCancellationRequested) { break; }

                        // Deduplicate against existing memory (exact + near-match)
                        const factNorm = fact.content.toLowerCase().replace(/[^a-z0-9]/g, '');
                        let isDupeOfExisting = existingContent.has(fact.content.toLowerCase());
                        if (!isDupeOfExisting) {
                            for (const existing of existingContent) {
                                const existNorm = existing.replace(/[^a-z0-9]/g, '');
                                if (existNorm.includes(factNorm) || factNorm.includes(existNorm)) {
                                    isDupeOfExisting = true;
                                    break;
                                }
                            }
                        }
                        if (isDupeOfExisting) {
                            totalSkipped++;
                            continue;
                        }

                        // Semantic dedup via Qdrant embeddings (catches paraphrased duplicates)
                        if (await memoryManager.isSemanticDuplicate(fact.content, 0.80)) {
                            totalSkipped++;
                            continue;
                        }

                        const tags = [...fact.tags, `source:${doc.path}`];
                        const entry = await memoryManager.addEntry(fact.tier, fact.content, tags);
                        // Index into Qdrant so subsequent facts can be checked semantically
                        await memoryManager.indexForSearch(entry);
                        existingContent.add(fact.content.toLowerCase());
                        totalIngested++;
                    }
                } catch (err) {
                    logError(`[doc-scan] Failed to extract from ${doc.path}: ${(err as Error).message}`);
                }
            }

            const linkedNote = linkedPaths.length > 0 ? ` + ${linkedPaths.length} linked` : '';
            const summary = `Doc scan complete: ${totalIngested} facts saved, ${totalSkipped} duplicates skipped (from ${foundDocs.length - linkedPaths.length}${linkedNote} files).`;
            logInfo(`[doc-scan] ${summary}`);
            vscode.window.showInformationMessage(summary);
        },
    );
}
