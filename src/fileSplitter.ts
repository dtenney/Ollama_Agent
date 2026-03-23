/**
 * fileSplitter.ts
 *
 * Programmatic large-file splitter. Works without a model — analyzes route/function
 * structure, groups by URL path or class, and writes new files.
 *
 * Supports: Python Flask blueprints, generic Python, TypeScript/JavaScript Express.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { PostFn } from './agent';

// ── Public interfaces ─────────────────────────────────────────────────────────

export interface FileSplit {
    name: string;           // e.g. "analytics"
    outputFile: string;     // relative to workspace root
    startLine: number;      // 1-based, inclusive (first item's start — for display)
    endLine: number;        // 1-based, inclusive (last item's end — for display)
    functions: string[];    // function/route names in this section
    blueprintVar?: string;  // Flask: new bp var e.g. "analytics_bp"
    /** Actual line ranges to extract — may be non-contiguous if routes interleave */
    lineRanges: Array<{ start: number; end: number }>; // 1-based, inclusive
}

export interface FileSplitPlan {
    sourceFile: string;             // absolute path
    relPath: string;                // relative to workspace root
    language: 'python' | 'typescript' | 'javascript' | 'unknown';
    framework: 'flask' | 'express' | 'fastapi' | 'none';
    headerLines: string[];          // imports + blueprint/router creation
    splits: FileSplit[];
    originalBlueprint?: string;     // e.g. "reports_api_bp"
    originalBlueprintName?: string; // e.g. "reports_api"
}

// ── Internal types ────────────────────────────────────────────────────────────

interface ParsedItem {
    startLine: number;       // 1-based
    endLine: number;         // 1-based, inclusive
    fnName: string;
    routePath?: string;
}

interface GroupedSection {
    name: string;
    items: ParsedItem[];
}

// ── Language / framework detection ───────────────────────────────────────────

function detectLanguageAndFramework(lines: string[]): {
    language: FileSplitPlan['language'];
    framework: FileSplitPlan['framework'];
    bpVar?: string;
    bpName?: string;
} {
    const head = lines.slice(0, 30).join('\n');

    const bpMatch = head.match(/^(\w+)\s*=\s*Blueprint\s*\(\s*['"](\w+)['"]/m);
    if (bpMatch) {
        return { language: 'python', framework: 'flask', bpVar: bpMatch[1], bpName: bpMatch[2] };
    }

    if (/APIRouter\(\)|from fastapi/.test(head)) {
        return { language: 'python', framework: 'fastapi' };
    }

    if (/from flask|import flask/.test(head)) {
        return { language: 'python', framework: 'flask' };
    }

    if (/Router\(\)|express\.Router/.test(head)) {
        const hasTypes = lines.slice(0, 60).some(l => /:\s*(string|number|boolean|void|Promise)/.test(l));
        return { language: hasTypes ? 'typescript' : 'javascript', framework: 'express' };
    }

    if (/^(def |class |import |from )/.test(head)) {
        return { language: 'python', framework: 'none' };
    }

    if (/export (function|class|const)/.test(head)) {
        return { language: 'typescript', framework: 'none' };
    }

    return { language: 'unknown', framework: 'none' };
}

// ── Header extraction ─────────────────────────────────────────────────────────

function extractHeader(lines: string[], framework: string, bpVar?: string): {
    headerLines: string[];
    headerEndLine: number; // 0-based index
} {
    if (framework === 'flask' && bpVar) {
        for (let i = 0; i < Math.min(lines.length, 50); i++) {
            if (lines[i].includes('Blueprint(')) {
                return { headerLines: lines.slice(0, i + 1), headerEndLine: i };
            }
        }
    }

    if (framework === 'express') {
        for (let i = 0; i < Math.min(lines.length, 50); i++) {
            if (/router\s*=.*Router\(|const router/.test(lines[i])) {
                return { headerLines: lines.slice(0, i + 1), headerEndLine: i };
            }
        }
    }

    // Generic: all leading imports/blanks/comments
    let last = 0;
    for (let i = 0; i < Math.min(lines.length, 60); i++) {
        const l = lines[i].trim();
        if (l === '' || l.startsWith('#') || l.startsWith('import ') || l.startsWith('from ')) {
            last = i;
        } else {
            break;
        }
    }
    return { headerLines: lines.slice(0, last + 1), headerEndLine: last };
}

// ── Flask route parser ────────────────────────────────────────────────────────

function parseFlask(lines: string[], bpVar: string): ParsedItem[] {
    const items: ParsedItem[] = [];
    const routeRe = new RegExp(`@${bpVar}\\.route\\s*\\(\\s*['"]([^'"]+)['"]`);
    const fnRe = /^def\s+(\w+)\s*\(/;
    const topRe = /^(def |class |@)/;

    let i = 0;
    while (i < lines.length) {
        const line = lines[i];

        if (line.startsWith('@') || fnRe.test(line)) {
            // Collect all leading decorator lines
            const blockStart = i;
            let routePath: string | undefined;

            while (i < lines.length && lines[i].startsWith('@')) {
                const m = routeRe.exec(lines[i]);
                if (m && !routePath) { routePath = m[1]; }
                i++;
            }

            // Must be followed by def
            if (i < lines.length && fnRe.test(lines[i])) {
                const fnName = fnRe.exec(lines[i])![1];
                i++; // skip the def line

                // Scan body until next top-level token
                while (i < lines.length) {
                    const tl = lines[i];
                    if (tl.length > 0 && !/^\s/.test(tl) && tl.trim() !== '') {
                        if (topRe.test(tl)) { break; }
                    }
                    i++;
                }

                items.push({ startLine: blockStart + 1, endLine: i, fnName, routePath });
                continue;
            }
            // Decorator without def — skip
            continue;
        }

        // Plain top-level def (helper)
        if (fnRe.test(line) && !/^\s/.test(line)) {
            const fnName = fnRe.exec(line)![1];
            const blockStart = i;
            i++;
            while (i < lines.length) {
                const tl = lines[i];
                if (tl.length > 0 && !/^\s/.test(tl) && tl.trim() !== '') {
                    if (topRe.test(tl)) { break; }
                }
                i++;
            }
            items.push({ startLine: blockStart + 1, endLine: i, fnName });
            continue;
        }

        i++;
    }

    return items;
}

// ── Generic Python parser ─────────────────────────────────────────────────────

function parseGenericPython(lines: string[]): ParsedItem[] {
    const items: ParsedItem[] = [];
    const topRe = /^(def|class)\s+(\w+)/;

    let i = 0;
    while (i < lines.length) {
        const m = topRe.exec(lines[i]);
        if (m) {
            const start = i;
            i++;
            while (i < lines.length) {
                const tl = lines[i];
                if (tl.length > 0 && !/^\s/.test(tl) && tl.trim() !== '') {
                    if (/^(def |class |@)/.test(tl)) { break; }
                }
                i++;
            }
            items.push({ startLine: start + 1, endLine: i, fnName: m[2] });
            continue;
        }
        i++;
    }
    return items;
}

// ── TypeScript/Express parser ─────────────────────────────────────────────────

function parseTypeScript(lines: string[]): ParsedItem[] {
    const items: ParsedItem[] = [];
    const routeRe = /router\.(get|post|put|patch|delete|use)\s*\(\s*['"`]([^'"`]+)['"`]/;
    const exportRe = /^export\s+(async\s+)?function\s+(\w+)/;

    let i = 0;
    while (i < lines.length) {
        const routeM = routeRe.exec(lines[i]);
        if (routeM) {
            const start = i;
            let depth = 0;
            for (; i < lines.length; i++) {
                for (const ch of lines[i]) {
                    if (ch === '{') depth++;
                    else if (ch === '}') { depth--; }
                }
                if (depth === 0 && i > start) { i++; break; }
            }
            items.push({ startLine: start + 1, endLine: i, fnName: `${routeM[1].toUpperCase()} ${routeM[2]}`, routePath: routeM[2] });
            continue;
        }

        const fnM = exportRe.exec(lines[i]);
        if (fnM) {
            const start = i;
            let depth = 0;
            for (; i < lines.length; i++) {
                for (const ch of lines[i]) {
                    if (ch === '{') depth++;
                    else if (ch === '}') { depth--; }
                }
                if (depth === 0 && i > start) { i++; break; }
            }
            items.push({ startLine: start + 1, endLine: i, fnName: fnM[2] });
            continue;
        }

        i++;
    }
    return items;
}

// ── Grouping algorithm ────────────────────────────────────────────────────────

function groupNameFromRoute(urlPath: string): string {
    const clean = urlPath.replace(/^\/+/, '').replace(/^api\//, '');
    const segs = clean.split('/').filter(s => s && !s.startsWith('<'));

    if (segs.length === 0) { return 'root'; }

    const first = segs[0].replace(/-/g, '_');
    const second = segs[1] ? segs[1].replace(/-/g, '_') : '';

    // Generic top-level namespaces — dive into second segment
    if (first === 'reports' || first === 'api') {
        if (!second) { return 'reports'; }
        // Group by first word of second segment (e.g. material-price-trend → material)
        const prefix = second.split('_')[0];
        return `${prefix}_reports`;
    }

    // analytics, sales, time, etc. — use first segment directly
    return first;
}

function groupItems(items: ParsedItem[]): GroupedSection[] {
    const groups: GroupedSection[] = [];
    const byName = new Map<string, GroupedSection>();
    let lastGroup: GroupedSection | null = null;

    for (const item of items) {
        if (item.routePath) {
            const name = groupNameFromRoute(item.routePath);
            if (!byName.has(name)) {
                const g: GroupedSection = { name, items: [] };
                byName.set(name, g);
                groups.push(g);
            }
            const g = byName.get(name)!;
            g.items.push(item);
            lastGroup = g;
        } else {
            // Helper — attaches to last active group
            if (lastGroup) {
                lastGroup.items.push(item);
            } else {
                const fallback = byName.get('misc') ?? (() => {
                    const g: GroupedSection = { name: 'misc', items: [] };
                    byName.set('misc', g);
                    groups.push(g);
                    return g;
                })();
                fallback.items.push(item);
                lastGroup = fallback;
            }
        }
    }

    return groups;
}

function mergeSmallGroups(groups: GroupedSection[], minRoutes = 2): GroupedSection[] {
    const result: GroupedSection[] = [];
    for (const g of groups) {
        const routeCount = g.items.filter(i => i.routePath).length;
        if (routeCount < minRoutes && result.length > 0) {
            result[result.length - 1].items.push(...g.items);
        } else {
            result.push({ name: g.name, items: [...g.items] });
        }
    }
    return result;
}

// ── analyzeFile ───────────────────────────────────────────────────────────────

export function analyzeFile(absPath: string, workspaceRoot?: string): FileSplitPlan {
    const raw = fs.readFileSync(absPath, 'utf8');
    const lines = raw.split('\n');
    const wsr = workspaceRoot ?? path.dirname(absPath);
    const relPath = path.relative(wsr, absPath).replace(/\\/g, '/');
    const dir = path.dirname(relPath).replace(/\\/g, '/');
    const ext = path.extname(absPath);

    const det = detectLanguageAndFramework(lines);
    const { language, framework } = det;
    const { headerLines, headerEndLine } = extractHeader(lines, framework, det.bpVar);

    let items: ParsedItem[] = [];
    if (framework === 'flask' && det.bpVar) {
        items = parseFlask(lines, det.bpVar);
    } else if (language === 'python') {
        items = parseGenericPython(lines);
    } else if (language === 'typescript' || language === 'javascript') {
        items = parseTypeScript(lines);
    }

    // Drop items that are entirely within the header block
    items = items.filter(it => it.startLine > headerEndLine + 1);

    const rawGroups = groupItems(items);
    const merged = mergeSmallGroups(rawGroups, 2);

    const sourceStem = path.basename(absPath, ext); // e.g. "reports_api"
    const splits: FileSplit[] = merged.map(g => {
        const sorted = g.items.slice().sort((a, b) => a.startLine - b.startLine);
        const prefix = dir && dir !== '.' ? `${dir}/` : '';
        // Avoid output filename colliding with source file (would create a circular import)
        const stem = `${g.name}_api`;
        const safeStem = stem === sourceStem ? `${g.name}_core_api` : stem;
        return {
            name: g.name,
            outputFile: `${prefix}${safeStem}${ext}`,
            startLine: sorted[0].startLine,
            endLine: sorted[sorted.length - 1].endLine,
            functions: sorted.map(i => i.fnName),
            blueprintVar: framework === 'flask' ? `${g.name}_bp` : undefined,
            lineRanges: sorted.map(i => ({ start: i.startLine, end: i.endLine })),
        };
    });

    return {
        sourceFile: absPath,
        relPath,
        language,
        framework,
        headerLines,
        splits,
        originalBlueprint: det.bpVar,
        originalBlueprintName: det.bpName,
    };
}

// ── Content builders ──────────────────────────────────────────────────────────

function buildFlaskSplit(plan: FileSplitPlan, split: FileSplit, allLines: string[]): string {
    const origBp = plan.originalBlueprint!;
    const newBp = split.blueprintVar!;

    const imports = plan.headerLines
        .filter(l => !l.includes(' = Blueprint('))
        .join('\n')
        .trimEnd();

    const bpLine = `${newBp} = Blueprint('${split.name}', __name__)`;

    // Extract non-contiguous line ranges and concatenate
    const bodyParts: string[] = [];
    for (const range of split.lineRanges) {
        const chunk = allLines
            .slice(range.start - 1, range.end)
            .map(l => l.replace(new RegExp(`@${origBp}\\.`, 'g'), `@${newBp}.`))
            .join('\n');
        bodyParts.push(chunk);
    }
    const body = bodyParts.join('\n').trimEnd();

    return `${imports}\n\n${bpLine}\n\n${body}\n`;
}

function buildFlaskAggregator(plan: FileSplitPlan): string {
    const origFile = path.basename(plan.sourceFile);
    const lines = [
        `# Auto-split from ${origFile}`,
        `# This file now imports and re-exports all sub-blueprints.`,
        `# Register each blueprint in your Flask app factory.`,
        '',
    ];

    for (const s of plan.splits) {
        const stem = path.basename(s.outputFile, path.extname(s.outputFile));
        lines.push(`from .${stem} import ${s.blueprintVar}`);
    }

    lines.push('', '# Register in app factory:');
    for (const s of plan.splits) {
        lines.push(`# app.register_blueprint(${s.blueprintVar})`);
    }

    return lines.join('\n') + '\n';
}

function buildGenericSplit(plan: FileSplitPlan, split: FileSplit, allLines: string[]): string {
    const header = plan.headerLines.join('\n').trimEnd();
    const bodyParts = split.lineRanges.map(r =>
        allLines.slice(r.start - 1, r.end).join('\n')
    );
    const body = bodyParts.join('\n').trimEnd();
    return `${header}\n\n${body}\n`;
}

function buildGenericAggregator(plan: FileSplitPlan): string {
    const origFile = path.basename(plan.sourceFile);
    const isPy = plan.language === 'python';
    const lines = [`# Auto-split from ${origFile}`, ''];
    for (const s of plan.splits) {
        const stem = path.basename(s.outputFile, path.extname(s.outputFile));
        lines.push(isPy ? `from .${stem} import *` : `export * from './${stem}';`);
    }
    return lines.join('\n') + '\n';
}

// ── executeSplit ──────────────────────────────────────────────────────────────

export async function executeSplit(
    plan: FileSplitPlan,
    workspaceRoot: string,
    post: PostFn
): Promise<string> {
    const allLines = fs.readFileSync(plan.sourceFile, 'utf8').split('\n');

    // Show plan summary
    const planLines = plan.splits.map(s => {
        const fns = s.functions.slice(0, 4).join(', ') + (s.functions.length > 4 ? '…' : '');
        return `  + ${s.outputFile}  (${s.functions.length} functions: ${fns})`;
    });
    post({
        type: 'status',
        text: `Split plan for ${plan.relPath}:\n${planLines.join('\n')}\n  ~ ${plan.relPath} → rewritten as aggregator`,
    });

    const written: string[] = [];

    for (const split of plan.splits) {
        const outAbs = path.resolve(workspaceRoot, split.outputFile);
        fs.mkdirSync(path.dirname(outAbs), { recursive: true });

        const content = plan.framework === 'flask'
            ? buildFlaskSplit(plan, split, allLines)
            : buildGenericSplit(plan, split, allLines);

        fs.writeFileSync(outAbs, content, 'utf8');
        written.push(split.outputFile);
    }

    // Rewrite original as aggregator
    const aggregator = plan.framework === 'flask'
        ? buildFlaskAggregator(plan)
        : buildGenericAggregator(plan);

    fs.writeFileSync(plan.sourceFile, aggregator, 'utf8');

    return [
        `Split complete — created ${written.length} files:`,
        ...written.map(f => `  + ${f}`),
        `  ~ ${plan.relPath} (rewritten as aggregator)`,
    ].join('\n');
}
