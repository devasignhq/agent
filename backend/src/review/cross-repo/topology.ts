// Org repository map: enumerate, classify, cluster into families, and derive
// consumer edges. The pure half is unit-tested; buildTopology does the GitHub walk.
import { v4 as uuid } from "uuid";
import { db } from "../../db.js";
import { gh, ghPaged } from "../../github/app.js";
import { probeCodeSearch } from "./code-search.js";
import { familyRoot, familyStem, languageAffixOf, roleOf } from "./naming.js";
import type {
  Installation,
  RepoTopology,
  TopoConfidence,
  TopoEdge,
  TopoFamily,
  TopoFamilyKind,
  TopoRepo,
  TopoRepoKind,
} from "../../types.js";

export const TOPOLOGY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_PAGES = 10;
const PER_PAGE = 100;
const MAX_CLASSIFY_REPOS = 60;
const MANIFEST_BYTES = 60_000;

export type FamilyDeclaration = {
  repo: string;
  name?: string;
  role?: string;
  sisters: string[];
  contract?: string;
};

const CONFIDENCE_RANK: Record<TopoConfidence, number> = { low: 0, medium: 1, high: 2 };
const KIND_RANK: Record<TopoFamilyKind, number> = {
  "shared-contract": 3,
  "sdk-family": 2,
  "service-client": 1,
  "monorepo-split": 0,
};

export function topologyStale(
  row: RepoTopology | null | undefined,
  install: Pick<Installation, "repoIds">,
  now: number
): boolean {
  if (!row) return true;
  if (now - row.generatedAt >= TOPOLOGY_MAX_AGE_MS) return true;
  return (install.repoIds?.length ?? 0) !== row.repoIdsAtBuild;
}

type Group = {
  members: Set<string>;
  kind: TopoFamilyKind;
  confidence: TopoConfidence;
  evidence: string[];
  name?: string;
};

function mergeOverlapping(groups: Group[]): Group[] {
  const out: Group[] = [];
  for (const g of groups) {
    const hit = out.find((o) => [...g.members].some((m) => o.members.has(m)));
    if (!hit) {
      out.push({ ...g, members: new Set(g.members), evidence: [...g.evidence] });
      continue;
    }
    for (const m of g.members) hit.members.add(m);
    for (const e of g.evidence) if (!hit.evidence.includes(e)) hit.evidence.push(e);
    if (CONFIDENCE_RANK[g.confidence] > CONFIDENCE_RANK[hit.confidence]) hit.confidence = g.confidence;
    if (KIND_RANK[g.kind] > KIND_RANK[hit.kind]) hit.kind = g.kind;
    hit.name = hit.name || g.name;
  }
  return out;
}

function nameForGroup(g: Group): string {
  if (g.name) return g.name;
  const stems = new Map<string, number>();
  for (const m of g.members) {
    const s = familyStem(m);
    stems.set(s, (stems.get(s) || 0) + 1);
  }
  let best = "";
  let bestN = 0;
  for (const [s, n] of stems) {
    if (n > bestN || (n === bestN && s.length < best.length)) {
      best = s;
      bestN = n;
    }
  }
  return best || familyRoot([...g.members][0]);
}

// Signals in the spec's precedence order: declared sisters win over a shared
// contract, which wins over dependency edges, which win over naming.
export function detectFamilies(repos: TopoRepo[], declarations: FamilyDeclaration[] = []): TopoFamily[] {
  const known = new Set(repos.map((r) => r.fullName));
  const active = repos.filter((r) => !r.archived);
  const groups: Group[] = [];

  for (const d of declarations) {
    const members = [d.repo, ...d.sisters].filter((m) => known.has(m));
    if (members.length < 2) continue;
    const skipped = d.sisters.filter((m) => !known.has(m));
    const evidence = [`declared in .devasign.yml (${d.repo})`];
    if (skipped.length) evidence.push(`declared but not connected: ${skipped.join(", ")}`);
    groups.push({
      members: new Set(members),
      kind: d.contract ? "shared-contract" : "sdk-family",
      confidence: "high",
      evidence,
      name: d.name,
    });
  }

  const byContract = new Map<string, string[]>();
  for (const d of declarations) {
    if (!d.contract || !known.has(d.repo)) continue;
    byContract.set(d.contract, [...(byContract.get(d.contract) || []), d.repo]);
  }
  for (const [contract, members] of byContract) {
    if (members.length < 2) continue;
    groups.push({
      members: new Set(members),
      kind: "shared-contract",
      confidence: "high",
      evidence: [`shared contract ${contract}`],
    });
  }

  const published = new Map<string, string>();
  for (const r of active) if (r.publishedName) published.set(r.publishedName, r.fullName);
  for (const consumer of active) {
    for (const dep of consumer.declaredDeps) {
      const provider = published.get(dep);
      if (!provider || provider === consumer.fullName) continue;
      groups.push({
        members: new Set([consumer.fullName, provider]),
        kind: "service-client",
        confidence: "medium",
        evidence: [`${consumer.fullName} depends on ${dep}`],
      });
    }
  }

  const byStem = new Map<string, string[]>();
  for (const r of active) {
    const s = familyStem(r.fullName);
    byStem.set(s, [...(byStem.get(s) || []), r.fullName]);
  }
  for (const [stem, members] of byStem) {
    if (members.length < 2) continue;
    const langs = new Set(members.map((m) => languageAffixOf(m)).filter(Boolean));
    groups.push({
      members: new Set(members),
      kind: langs.size >= 2 ? "sdk-family" : "monorepo-split",
      confidence: "medium",
      evidence: [`naming stem "${stem}"`],
      name: stem,
    });
  }

  return mergeOverlapping(groups)
    .filter((g) => g.members.size >= 2)
    .map((g) => ({
      name: nameForGroup(g),
      kind: g.kind,
      members: [...g.members].sort(),
      confidence: g.confidence,
      evidence: g.evidence,
    }));
}

export function buildEdges(repos: TopoRepo[], declarations: FamilyDeclaration[] = []): TopoEdge[] {
  const active = repos.filter((r) => !r.archived);
  const published = new Map<string, string>();
  for (const r of active) if (r.publishedName) published.set(r.publishedName, r.fullName);

  const edges: TopoEdge[] = [];
  const seen = new Set<string>();
  const push = (e: TopoEdge) => {
    const key = `${e.consumer}|${e.provider}|${e.via}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(e);
  };

  for (const consumer of active) {
    for (const dep of consumer.declaredDeps) {
      const provider = published.get(dep);
      if (!provider || provider === consumer.fullName) continue;
      push({
        consumer: consumer.fullName,
        provider,
        via: "package-dep",
        evidence: `${consumer.fullName} manifest depends on "${dep}"`,
        confidence: "high",
      });
    }
  }

  const known = new Set(active.map((r) => r.fullName));
  for (const d of declarations) {
    if (!d.contract || !known.has(d.repo)) continue;
    const provider = d.contract.split(":")[0];
    if (!known.has(provider) || provider === d.repo) continue;
    push({
      consumer: d.repo,
      provider,
      via: "http-contract",
      evidence: `${d.repo} declares contract ${d.contract}`,
      confidence: "high",
    });
  }

  return edges;
}

export function familyOf(topology: RepoTopology | null | undefined, fullName: string): TopoFamily | null {
  if (!topology) return null;
  const hits = topology.families.filter((f) => f.members.includes(fullName));
  if (!hits.length) return null;
  return hits.sort((a, b) => CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence])[0];
}

// Repos worth checking for breakage, best first: declared consumers, then family
// siblings, then everything else by recency.
export function rankSiblings(
  topology: RepoTopology | null | undefined,
  fullName: string,
  all: string[],
  limit: number
): string[] {
  const score = new Map<string, number>();
  for (const n of all) if (n !== fullName) score.set(n, 0);
  if (topology) {
    for (const e of topology.edges) {
      if (e.provider === fullName && score.has(e.consumer)) {
        score.set(e.consumer, (score.get(e.consumer) || 0) + 100);
      }
    }
    const fam = familyOf(topology, fullName);
    for (const m of fam?.members || []) if (score.has(m)) score.set(m, (score.get(m) || 0) + 50);
    for (const r of topology.repos) {
      if (!score.has(r.fullName)) continue;
      if (r.archived) score.set(r.fullName, score.get(r.fullName)! - 1000);
      else score.set(r.fullName, score.get(r.fullName)! + Math.min(10, r.pushedAt / 1e12));
    }
  }
  return [...score.entries()]
    .filter(([, s]) => s > -1000)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([n]) => n);
}

type RawRepo = {
  id: number;
  full_name: string;
  description?: string | null;
  language?: string | null;
  archived?: boolean;
  pushed_at?: string | null;
  default_branch?: string | null;
};

// The one paginating enumerator in the codebase. Truncation is reported, never
// silent: an unseen repo must not be reported "absent" by the parity pass.
export async function enumerateRepos(
  installationId: number
): Promise<{ repos: RawRepo[]; totalCount: number | null; truncated: boolean }> {
  const repos: RawRepo[] = [];
  let totalCount: number | null = null;
  let url: string | null = `/installation/repositories?per_page=${PER_PAGE}`;
  let pages = 0;
  while (url && pages < MAX_PAGES) {
    const { body, nextUrl } = await ghPaged<any>(installationId, url);
    if (typeof body?.total_count === "number") totalCount = body.total_count;
    for (const r of body?.repositories || []) repos.push(r as RawRepo);
    pages += 1;
    url = nextUrl;
  }
  const truncated = Boolean(url) || (totalCount !== null && repos.length < totalCount);
  return { repos, totalCount, truncated };
}

const MANIFESTS: Array<{ file: string; kind: TopoRepoKind }> = [
  { file: "package.json", kind: "library" },
  { file: "go.mod", kind: "library" },
  { file: "pyproject.toml", kind: "library" },
  { file: "Cargo.toml", kind: "contract" },
  { file: "openapi.yaml", kind: "contract" },
  { file: "openapi.json", kind: "contract" },
  { file: "schema.graphql", kind: "contract" },
];

function decodeContents(body: any): string | null {
  if (!body || body.encoding !== "base64" || typeof body.content !== "string") return null;
  const text = Buffer.from(body.content, "base64").toString("utf8");
  return text.length > MANIFEST_BYTES ? text.slice(0, MANIFEST_BYTES) : text;
}

export function parseManifest(
  file: string,
  text: string
): { publishedName?: string; declaredDeps: string[] } {
  const deps = new Set<string>();
  let publishedName: string | undefined;
  try {
    if (file === "package.json") {
      const j = JSON.parse(text);
      if (typeof j.name === "string") publishedName = j.name;
      for (const block of [j.dependencies, j.peerDependencies, j.devDependencies]) {
        for (const k of Object.keys(block || {})) deps.add(k);
      }
    } else if (file === "go.mod") {
      const mod = text.match(/^module\s+(\S+)/m);
      if (mod) publishedName = mod[1];
      for (const m of text.matchAll(/^\s*(?:require\s+)?([\w.\-~/]+\.[\w.\-~/]+)\s+v\d\S*/gm)) deps.add(m[1]);
    } else if (file === "pyproject.toml") {
      const nm = text.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
      if (nm) publishedName = nm[1];
      for (const m of text.matchAll(/^\s*["']?([A-Za-z0-9_.-]+)["']?\s*[=><~]{1,2}/gm)) deps.add(m[1]);
    } else if (file === "Cargo.toml") {
      const nm = text.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
      if (nm) publishedName = nm[1];
    }
  } catch {
    // A malformed manifest costs us one repo's edges, never the whole build.
  }
  return { publishedName, declaredDeps: [...deps].slice(0, 200) };
}

function kindFor(fullName: string, manifest: string | null, language: string | undefined): TopoRepoKind {
  const role = roleOf(fullName);
  if (role === "sdk" || role === "client") return "sdk";
  if (role === "service" || role === "server" || role === "backend" || role === "api") return "service";
  if (role === "frontend" || role === "web") return "frontend";
  if (role === "cli") return "cli";
  if (role === "contract") return "contract";
  if (manifest === "Cargo.toml" && /sol|contract|escrow/i.test(fullName)) return "contract";
  if (manifest === "openapi.yaml" || manifest === "openapi.json" || manifest === "schema.graphql") {
    return "contract";
  }
  if (language === "HCL" || language === "Dockerfile") return "infra";
  if (manifest) return "library";
  return "unknown";
}

async function classify(installationId: number, raw: RawRepo): Promise<TopoRepo> {
  const [owner, name] = raw.full_name.split("/");
  const base: TopoRepo = {
    fullName: raw.full_name,
    description: raw.description || undefined,
    language: raw.language || undefined,
    kind: "unknown",
    declaredDeps: [],
    archived: Boolean(raw.archived),
    pushedAt: raw.pushed_at ? Date.parse(raw.pushed_at) : 0,
    defaultBranch: raw.default_branch || "main",
  };
  const row = db.find("repositories", (r) => r.owner === owner && r.name === name);
  if (row) base.repoId = row.id;
  if (base.archived) return base;

  let entries: any[] = [];
  try {
    entries = await gh<any[]>(installationId, `/repos/${owner}/${name}/contents/`);
  } catch {
    return base;
  }
  const present = new Set((entries || []).map((e: any) => e?.name).filter(Boolean));
  const hit = MANIFESTS.find((m) => present.has(m.file));
  if (!hit) {
    base.kind = kindFor(raw.full_name, null, base.language);
    return base;
  }
  try {
    const body = await gh<any>(installationId, `/repos/${owner}/${name}/contents/${hit.file}`);
    const text = decodeContents(body);
    if (text) {
      const parsed = parseManifest(hit.file, text);
      base.publishedName = parsed.publishedName;
      base.declaredDeps = parsed.declaredDeps;
    }
  } catch {
    // Manifest unreadable — the repo still belongs on the map, just without edges.
  }
  base.kind = kindFor(raw.full_name, hit.file, base.language);
  return base;
}

async function readDeclaration(installationId: number, fullName: string): Promise<FamilyDeclaration | null> {
  const [owner, name] = fullName.split("/");
  try {
    const body = await gh<any>(installationId, `/repos/${owner}/${name}/contents/.devasign.yml`);
    const text = decodeContents(body);
    if (!text) return null;
    return parseFamilyDeclaration(fullName, text);
  } catch {
    return null;
  }
}

// Minimal reader for the `family:` block of .devasign.yml. Deliberately not a YAML
// parser: this reads five known keys and ignores everything else.
export function parseFamilyDeclaration(fullName: string, yml: string): FamilyDeclaration | null {
  const lines = yml.split(/\r?\n/);
  const start = lines.findIndex((l) => /^family:\s*(#.*)?$/.test(l));
  if (start === -1) return null;
  const decl: FamilyDeclaration = { repo: fullName, sisters: [] };
  let inSisters = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line)) break;
    const body = line.replace(/#.*$/, "").trimEnd();
    if (!body.trim()) continue;
    const kv = body.match(/^\s{2}(\w+):\s*(.*)$/);
    if (kv) {
      inSisters = kv[1] === "sisters";
      const val = kv[2].trim().replace(/^["']|["']$/g, "");
      if (kv[1] === "name" && val) decl.name = val;
      if (kv[1] === "role" && val) decl.role = val;
      if (kv[1] === "contract" && val) decl.contract = val;
      continue;
    }
    const item = body.match(/^\s+-\s+(.+)$/);
    if (item && inSisters) {
      const val = item[1].trim().replace(/^["']|["']$/g, "");
      if (val.includes("/")) decl.sisters.push(val);
    }
  }
  if (!decl.name && !decl.sisters.length && !decl.contract) return null;
  return decl;
}

export async function buildTopology(install: Installation): Promise<RepoTopology> {
  const t0 = Date.now();
  const { repos: raw, totalCount, truncated } = await enumerateRepos(install.installationId);
  const slice = raw.slice(0, MAX_CLASSIFY_REPOS);

  const repos: TopoRepo[] = [];
  for (const r of slice) repos.push(await classify(install.installationId, r));

  const declarations: FamilyDeclaration[] = [];
  for (const r of repos.filter((x) => !x.archived).slice(0, MAX_CLASSIFY_REPOS)) {
    const d = await readDeclaration(install.installationId, r.fullName);
    if (d) declarations.push(d);
  }

  const codeSearch = await probeCodeSearch(
    install.installationId,
    install.accountLogin,
    install.accountType === "Organization"
  );
  const row: RepoTopology = {
    id: uuid(),
    installationId: install.id,
    owner: install.accountLogin,
    isOrg: install.accountType === "Organization",
    generatedAt: Date.now(),
    buildMs: Date.now() - t0,
    repoCount: repos.length,
    repoIdsAtBuild: install.repoIds?.length ?? 0,
    totalCount,
    truncated: truncated || raw.length > slice.length,
    repos,
    families: detectFamilies(repos, declarations),
    edges: buildEdges(repos, declarations),
    codeSearch,
    error: null,
  };

  const prior = db.find("repoTopologies", (t) => t.installationId === install.id);
  if (prior) {
    db.update("repoTopologies", (t) => t.id === prior.id, { ...row, id: prior.id });
    return { ...row, id: prior.id };
  }
  db.insert("repoTopologies", row);
  return row;
}

export function topologyFor(installationId: string): RepoTopology | null {
  return db.find("repoTopologies", (t) => t.installationId === installationId);
}
