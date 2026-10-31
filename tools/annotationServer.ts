#!/usr/bin/env node
/**
 * Local annotation UI. Two annotators open separate URLs, label with 1/2/3,
 * and the server writes one JSONL row per case (last write wins).
 */
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";

interface CampaignRow {
    caseId: string;
    source: string;
    input: string;
    answer: string;
    expected: string;
}

interface LabelRow {
    caseId: string;
    annotator: string;
    label: string;
    note?: string;
}

export interface AnnotationServerOptions {
    annotator: string;
    port: number;
    campaignPath?: string;
    outputPath?: string;
}

export interface AnnotationServer {
    server: Server;
    url: string;
    close: () => Promise<void>;
}

type CasePayload = {
    caseId: string;
    source: string;
    input: string;
    answer: string;
    expected: string;
    annotator?: string;
    label?: string;
    note: string;
};

type ParsedLabel = {
    caseId?: string;
    label?: string;
    note?: string;
};

type SendResponse = (response: ServerResponse, status: number, body: string, type?: string) => void;

type AnnotationServerFactory = (options: AnnotationServerOptions) => Promise<AnnotationServer>;

const loadCsvRows: (path: string) => CampaignRow[] = (path: string): CampaignRow[] => {
    const raw: string = readFileSync(path, "utf8");
    const lines: string[] = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length === 0) {
        return [];
    }
    const records: string[][] = [];
    let record: string[] = [];
    let cell: string = "";
    let quoted: boolean = false;
    for (let index: number = 0; index < raw.length; index += 1) {
        const char: string = raw[index];
        if (char === '"') {
            if (quoted && raw[index + 1] === '"') {
                cell += '"';
                index += 1;
            } else {
                quoted = !quoted;
            }
        } else if (char === "," && !quoted) {
            record.push(cell);
            cell = "";
        } else if ((char === "\n" || char === "\r") && !quoted) {
            if (char === "\r" && raw[index + 1] === "\n") {
                index += 1;
            }
            record.push(cell);
            records.push(record);
            record = [];
            cell = "";
        } else {
            cell += char;
        }
    }
    if (cell.length > 0 || record.length > 0) {
        record.push(cell);
        records.push(record);
    }
    const header: string[] = records[0].map((entry) => entry.trim());
    const get: (row: string[], name: string) => string = (row: string[], name: string): string => row[header.indexOf(name)] ?? "";
    return records.slice(1).map((row) => ({
        caseId: get(row, "caseId"),
        source: get(row, "source"),
        input: get(row, "input"),
        answer: get(row, "answer"),
        expected: get(row, "expected"),
    }));
};

const readLabels: (path: string) => LabelRow[] = (path: string): LabelRow[] => {
    if (!existsSync(path)) {
        return [];
    }
    return readFileSync(path, "utf8")
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as LabelRow);
};

const saveLabels: (path: string, labels: Map<string, LabelRow>) => void = (path: string, labels: Map<string, LabelRow>): void => {
    writeFileSync(path, [...labels.values()].map((row) => JSON.stringify(row)).join("\n") + (labels.size > 0 ? "\n" : ""), "utf8");
};

const html: (annotator: string) => string = (annotator: string): string => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>AMP annotation ${annotator}</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:860px;margin:40px auto;padding:0 20px;color:#111}
.card{border:1px solid #ddd;border-radius:12px;padding:20px;margin:16px 0;background:#fff}
.meta{color:#666;font-size:13px}.pre{white-space:pre-wrap;background:#f7f7f7;padding:12px;border-radius:8px}
button{font-size:16px;padding:10px 18px;margin:6px 6px 6px 0;border-radius:8px;border:1px solid #bbb;background:#fafafa;cursor:pointer}
button:hover{background:#eee}.ok{border-color:#2a7}.bad{border-color:#c33}.unsure{border-color:#ca0}
textarea{width:100%;min-height:70px;margin-top:8px;padding:8px;box-sizing:border-box}
.bar{position:sticky;bottom:0;background:#fff;padding:12px 0;border-top:1px solid #eee}
</style></head><body>
<h2>AMP 盲标 <small>${annotator}</small></h2>
<p class="meta">1=correct 2=incorrect 3=unsure｜不要看 repo 里的 humanLabel/actual｜共 <b id="total">?</b> 条</p>
<div class="card" id="case"><div class="meta">loading…</div></div>
<div class="bar"><button class="ok" onclick="mark('correct')">1 correct</button><button class="bad" onclick="mark('incorrect')">2 incorrect</button><button class="unsure" onclick="mark('unsure')">3 unsure</button><button onclick="skip()">跳过</button><span id="prog"></span></div>
<textarea id="note" placeholder="note（可选）"></textarea>
<script>
let rows=[], index=0;
const esc=s=>String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
async function load(){rows=await (await fetch('/api/cases')).json(); document.getElementById('total').textContent=rows.length; render();}
function render(){const r=rows[index]; if(!r){document.getElementById('case').innerHTML='<b>done</b>'; document.getElementById('prog').textContent=''; return;}
document.getElementById('case').innerHTML='<div class="meta">'+esc(r.caseId)+' · '+esc(r.source)+'</div><h3>Input</h3><div class="pre">'+esc(r.input)+'</div><h3>Answer</h3><div class="pre">'+esc(r.answer)+'</div>'+(r.expected?'<div class="meta">expected: '+esc(r.expected)+'</div>':'');
document.getElementById('note').value=r.note||''; document.getElementById('prog').textContent=(index+1)+'/'+rows.length;}
async function mark(label){const r=rows[index]; if(!r)return; await fetch('/api/labels',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({caseId:r.caseId,label,note:document.getElementById('note').value})}); index++; render();}
function skip(){index++; render();}
document.addEventListener('keydown',e=>{if(e.key==='1')mark('correct'); if(e.key==='2')mark('incorrect'); if(e.key==='3')mark('unsure');});
load();
</script></body></html>`;

export const startAnnotationServer: AnnotationServerFactory = async (options: AnnotationServerOptions): Promise<AnnotationServer> => {
    const campaignPath: string = options.campaignPath ?? "docs/annotation-campaign.csv";
    const outputPath: string = options.outputPath ?? `docs/eval/annotations-${options.annotator}.jsonl`;
    const campaign: CampaignRow[] = loadCsvRows(campaignPath);
    const labels: Map<string, LabelRow> = new Map<string, LabelRow>(readLabels(outputPath).map((row) => [row.caseId, row]));
    const send: SendResponse = (response: ServerResponse, status: number, body: string, type: string = "application/json"): void => {
        response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
        response.end(body);
    };
    const handler: (request: IncomingMessage, response: ServerResponse) => void = (request: IncomingMessage, response: ServerResponse): void => {
        const url: URL = new URL(request.url ?? "/", "http://127.0.0.1");
        if (request.method === "GET" && url.pathname === "/") {
            return send(response, 200, html(options.annotator), "text/html; charset=utf-8");
        }
        if (request.method === "GET" && url.pathname === "/api/cases") {
            const rows: CasePayload[] = campaign.map((row) => ({ ...row, ...(labels.get(row.caseId) ?? {}), note: labels.get(row.caseId)?.note ?? "" }));
            return send(response, 200, JSON.stringify(rows));
        }
        if (request.method === "GET" && url.pathname === "/api/progress") {
            return send(response, 200, JSON.stringify({ done: labels.size, total: campaign.length }));
        }
        if (request.method === "POST" && url.pathname === "/api/labels") {
            let body: string = "";
            request.on("data", (chunk) => {
                body += chunk;
                if (body.length > 100_000) {
                    request.destroy();
                }
            });
            request.on("end", () => {
                try {
                    const parsed: ParsedLabel = JSON.parse(body) as ParsedLabel;
                    if (typeof(parsed.caseId) !== "string" || typeof(parsed.label) !== "string" || !["correct", "incorrect", "unsure"].includes(parsed.label)) {
                        return send(response, 400, JSON.stringify({ error: "invalid label" }));
                    }
                    if (!campaign.some((row) => row.caseId === parsed.caseId)) {
                        return send(response, 400, JSON.stringify({ error: "unknown case" }));
                    }
                    labels.set(parsed.caseId, {
                        caseId: parsed.caseId,
                        annotator: options.annotator,
                        label: parsed.label,
                        ...(typeof(parsed.note) === "string" && parsed.note.trim().length > 0 ? { note: parsed.note.trim() } : {}),
                    });
                    saveLabels(outputPath, labels);
                    return send(response, 200, JSON.stringify({ done: labels.size, total: campaign.length }));
                } catch {
                    return send(response, 400, JSON.stringify({ error: "bad json" }));
                }
            });
            return;
        }
        return send(response, 404, JSON.stringify({ error: "not found" }));
    };

    const server: Server = createServer(handler);
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port, "127.0.0.1", () => resolve());
    });
    const address: AddressInfo | string | null = server.address();
    const port: number = typeof(address) === "object" && address !== null ? address.port : options.port;
    return {
        server,
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise<void>((resolve, reject) => server.close((error) => (error === (void 0) ? resolve() : reject(error)))),
    };
};

const IsMain: boolean = process.argv[1] !== (void 0) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (IsMain) {
    const args: string[] = process.argv.slice(2);
    const annotator: string = args.find((arg) => arg.startsWith("--annotator="))?.split("=")[1] ?? "A";
    const port: number = Number(args.find((arg) => arg.startsWith("--port="))?.split("=")[1] ?? "8787");
    const running: AnnotationServer = await startAnnotationServer({ annotator, port });
    console.log(`annotation UI: ${running.url} (${annotator})`);
    console.log("Ctrl+C to stop");
}
