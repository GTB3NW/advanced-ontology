/**
 * Ontology-as-code for Neo4j. Runs directly on Node >= 23.6 (native type stripping).
 *
 *   node ontology.ts check DIR                 validate the YAML and diff core modules against the lock file
 *   node ontology.ts build DIR [--out build] [--edition enterprise|community] [--graph neo4j] [--allow-breaking]
 *   node ontology.ts lock  DIR                 accept the current core modules as the new baseline
 *
 * See ../ref/format.md for the YAML format.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";

type Pick = "max" | "min";
type Reducer = { field: string; pick: Pick };
type Spec = {
  type?: string; required?: boolean; description?: string; struct?: string;
  multi?: boolean; reducers?: Reducer[]; derived?: string; rel?: string;
};
// YAML elements are validated key-by-key below, so they are loosely typed here.
type El = Record<string, any> & { _file: string; _status: string; _module: string };

const SCALARS = new Set(["STRING", "INTEGER", "FLOAT", "BOOLEAN", "DATE", "LOCAL TIME", "ZONED TIME",
  "LOCAL DATETIME", "ZONED DATETIME", "DURATION", "POINT"]);
const RESERVED_LABELS = ["Helper", "Value"];
const KINDS = ["structs", "interfaces", "objectTypes", "linkTypes", "actions"] as const;
type Kind = (typeof KINDS)[number];
const MODULE_KEYS = new Set(["module", "status", "owner", "description", "security", ...KINDS]);
const PROP_KEYS = new Set(["type", "required", "description", "struct", "multi", "reducers", "derived", "rel"]);
const FIELD_KEYS = new Set(["type", "required", "description"]);
const ELEMENT_KEYS: Record<Kind, Set<string>> = {
  structs: new Set(["description", "storage", "includes", "fields", "mainField"]),
  interfaces: new Set(["description", "extends", "properties"]),
  objectTypes: new Set(["description", "implements", "key", "visibility", "properties", "resolution"]),
  linkTypes: new Set(["description", "from", "to", "cardinality", "properties", "backedBy"]),
  actions: new Set(["description", "target", "params", "writes", "cypher"]),
};
const CARDINALITIES = new Set(["one-to-one", "one-to-many", "many-to-one", "many-to-many"]);
const PASCAL = /^[A-Z][A-Za-z0-9]*$/;
const CAMEL = /^[a-z][A-Za-z0-9]*$/;
const UPPER_SNAKE = /^[A-Z][A-Z0-9_]*$/;
const LABEL_IN_PATTERN = /\(\s*\w*\s*:\s*([A-Za-z_]\w*)/g;
const REL_IN_PATTERN = /\[\s*\w*\s*:\s*([A-Za-z_][\w|]*)/g;
const LOCK_FILE = "ontology.lock.json";

const normType = (t: unknown) =>
  String(t ?? "").trim().toUpperCase().replace(/\s+/g, " ").replaceAll("< ", "<").replaceAll(" >", ">");
const listInner = (t: string) => /^LIST<(.+)>$/.exec(t)?.[1] ?? null;
const validType = (t: string) => SCALARS.has(listInner(t) ?? t);
const cypherType = (t: string) => { const inner = listInner(t); return inner ? `LIST<${inner} NOT NULL>` : t; };
const upperSnake = (name: string) => name.replace(/(?<!^)(?=[A-Z])/g, "_").toUpperCase();
const snake = (name: string) => upperSnake(name).toLowerCase();
const literal = (v: unknown) =>
  typeof v === "boolean" || typeof v === "number" ? String(v) : `'${String(v).replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
const normSpec = (spec: unknown): Spec => (typeof spec === "string" ? { type: spec } : { ...(spec as Spec ?? {}) });
const entries = <T = any>(o: unknown): [string, T][] => Object.entries((o ?? {}) as Record<string, T>);
const uniq = <T>(xs: T[]) => [...new Set(xs)];
const lcFirst = (s: string) => s[0].toLowerCase() + s.slice(1);
const oneLine = (s: string) => s.split(/\s+/).filter(Boolean).join(" ");
const matches = (re: RegExp, s: string) => [...s.matchAll(re)].map((m) => m[1]);
/** JSON with sorted keys, so signatures compare and diff stably. */
const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, val[k]]))
      : val);

class Ontology {
  errors: string[] = [];
  warnings: string[] = [];
  notes: string[] = [];
  el: Record<Kind, Record<string, El>> = { structs: {}, interfaces: {}, objectTypes: {}, linkTypes: {}, actions: {} };
  security: [string, any][] = [];
  root: string;

  constructor(root: string) {
    this.root = root;
    this.load();
    if (!this.errors.length) this.validate();
  }

  // ---------- loading ----------
  private load() {
    const files = existsSync(this.root)
      ? (readdirSync(this.root, { recursive: true }) as string[]).filter((f) => /\.ya?ml$/.test(f)).sort()
      : [];
    if (!files.length) this.errors.push(`${this.root}: no .yaml files found`);
    for (const rel of files) {
      const doc = (parseYaml(readFileSync(join(this.root, rel), "utf8")) ?? {}) as Record<string, any>;
      for (const k of Object.keys(doc)) if (!MODULE_KEYS.has(k)) this.errors.push(`${rel}: unknown top-level key '${k}'`);
      if (!("module" in doc)) this.errors.push(`${rel}: missing 'module'`);
      const status = doc.status ?? "extension";
      if (status !== "core" && status !== "extension") this.errors.push(`${rel}: status must be core or extension`);
      for (const kind of KINDS) {
        for (const [name, body] of entries(doc[kind])) {
          if (this.el[kind][name]) {
            this.errors.push(`${rel}: ${kind}.${name} already declared in ${this.el[kind][name]._file}`);
            continue;
          }
          const el: El = { ...(body ?? {}), _file: rel, _status: status, _module: doc.module ?? rel };
          for (const k of Object.keys(body ?? {})) {
            if (!ELEMENT_KEYS[kind].has(k)) this.errors.push(`${rel}: ${kind}.${name} has unknown key '${k}'`);
          }
          this.el[kind][name] = el;
        }
      }
      if (doc.security) this.security.push([rel, doc.security]);
    }
  }

  // ---------- derived views of the model ----------
  get structs() { return this.el.structs; }
  get interfaces() { return this.el.interfaces; }
  get types() { return this.el.objectTypes; }
  get links() { return this.el.linkTypes; }
  get actions() { return this.el.actions; }

  structFields(name: string, seen: string[] = []): Record<string, Spec> {
    const s = this.structs[name];
    if (!s || seen.includes(name)) return {};
    const out: Record<string, Spec> = {};
    for (const inc of s.includes ?? []) Object.assign(out, this.structFields(inc, [...seen, name]));
    for (const [f, spec] of entries(s.fields)) out[f] = normSpec(spec);
    return out;
  }

  interfaceAncestors(name: string, seen: string[] = []): string[] {
    const out: string[] = [];
    for (const parent of this.interfaces[name]?.extends ?? []) {
      if (seen.includes(parent)) continue;
      out.push(parent, ...this.interfaceAncestors(parent, [...seen, name]));
    }
    return uniq(out);
  }

  typeInterfaces(t: string): string[] {
    return uniq((this.types[t].implements ?? []).flatMap((i: string) => [i, ...this.interfaceAncestors(i)]));
  }

  labels(t: string): string[] {
    return [t, ...this.typeInterfaces(t), ...(this.types[t].visibility === "hidden" ? ["Helper"] : [])];
  }

  implementers(i: string): string[] {
    return Object.keys(this.types).filter((t) => this.typeInterfaces(t).includes(i));
  }

  private ownProps(name: string): Record<string, Spec> {
    const body = this.interfaces[name] ?? this.types[name];
    return Object.fromEntries(entries(body?.properties).map(([k, v]) => [k, normSpec(v)]));
  }

  /** Effective properties of an object type or interface, inherited ones first. */
  props(owner: string): Record<string, Spec> {
    const sources = owner in this.interfaces
      ? [...this.interfaceAncestors(owner).reverse(), owner]
      : [...this.typeInterfaces(owner).reverse(), owner];
    return Object.assign({}, ...sources.map((s) => this.ownProps(s)));
  }

  isNodeStruct(p: Spec) {
    return !!p.struct && (this.structs[p.struct]?.storage ?? "flat") === "node";
  }

  structRel(pname: string, p: Spec) {
    return p.rel ?? `HAS_${upperSnake(pname)}`;
  }

  /** Property keys that live on the owner node itself. */
  storedKeys(owner: string): string[] {
    const keys: string[] = [];
    for (const [pname, p] of Object.entries(this.props(owner))) {
      if (p.derived) continue;
      if (!p.struct) { keys.push(pname); continue; }
      const s = this.structs[p.struct] ?? {};
      if ((s.storage ?? "flat") === "flat") keys.push(...Object.keys(this.structFields(p.struct)).map((f) => `${pname}_${f}`));
      else if (s.mainField) keys.push(pname);
    }
    return keys;
  }

  /** Every node-stored struct property, as [owner, property name, spec, struct name]. */
  nodeStructUses(): [string, string, Spec, string][] {
    const out: [string, string, Spec, string][] = [];
    for (const owner of [...Object.keys(this.interfaces), ...Object.keys(this.types)]) {
      for (const [pname, p] of Object.entries(this.ownProps(owner))) {
        if (this.isNodeStruct(p)) out.push([owner, pname, p, p.struct!]);
      }
    }
    return out;
  }

  knownLabels(): Set<string> {
    return new Set([...Object.keys(this.types), ...Object.keys(this.interfaces), ...RESERVED_LABELS,
      ...Object.entries(this.structs).filter(([, b]) => b.storage === "node").map(([s]) => s)]);
  }

  knownRels(): Set<string> {
    return new Set([...Object.keys(this.links), ...this.nodeStructUses().map(([, n, p]) => this.structRel(n, p))]);
  }

  labelExists(name: string) {
    return name in this.types || name in this.interfaces;
  }

  // ---------- validation ----------
  private err(el: El, msg: string) { this.errors.push(`${el._file}: ${msg}`); }
  private warn(el: El, msg: string) { this.warnings.push(`${el._file}: ${msg}`); }

  /** Core modules may not depend on extension modules. */
  private checkDep(el: El, kind: Kind, ref: string) {
    const target = this.el[kind][ref];
    if (target && el._status === "core" && target._status === "extension") {
      this.err(el, `core element depends on extension element ${kind}.${ref} (dependencies must point toward core)`);
    }
  }

  private validate() {
    for (const kind of KINDS) {
      for (const [name, el] of Object.entries(this.el[kind])) {
        if (!el.description) this.err(el, `${kind}.${name} needs a description (agents read it)`);
        if (kind === "linkTypes") { if (!UPPER_SNAKE.test(name)) this.err(el, `link type ${name} must be UPPER_SNAKE_CASE`); }
        else if (kind === "actions") { if (!CAMEL.test(name)) this.err(el, `action ${name} must be camelCase`); }
        else if (!PASCAL.test(name)) this.err(el, `${kind}.${name} must be PascalCase`);
        if (RESERVED_LABELS.includes(name)) this.err(el, `${name} is a reserved label`);
      }
    }
    for (const [n, s] of Object.entries(this.structs)) this.validateStruct(n, s);
    for (const [n, i] of Object.entries(this.interfaces)) this.validateInterface(n, i);
    for (const [n, t] of Object.entries(this.types)) this.validateType(n, t);
    for (const [n, l] of Object.entries(this.links)) this.validateLink(n, l);
    for (const [n, a] of Object.entries(this.actions)) this.validateAction(n, a);
    for (const [file, sec] of this.security) this.validateSecurity(file, sec);
    this.ruleOfThree();
    this.compositionSmell();
  }

  private validateStruct(name: string, s: El) {
    const storage = s.storage ?? "flat";
    if (storage !== "flat" && storage !== "node") this.err(s, `struct ${name}: storage must be flat or node`);
    for (const inc of s.includes ?? []) {
      if (!this.structs[inc]) this.err(s, `struct ${name} includes unknown struct ${inc}`);
      this.checkDep(s, "structs", inc);
    }
    if (this.includesCycle(name)) this.err(s, `struct ${name} has an includes cycle`);
    const fields = this.structFields(name);
    for (const [f, spec] of Object.entries(fields)) {
      if (!CAMEL.test(f)) this.err(s, `struct ${name}.${f} must be camelCase`);
      for (const k of Object.keys(spec)) if (!FIELD_KEYS.has(k)) this.err(s, `struct ${name}.${f} has unknown key '${k}'`);
      if (!validType(normType(spec.type))) this.err(s, `struct ${name}.${f} has invalid type ${JSON.stringify(spec.type)}`);
    }
    if (s.mainField) {
      if (storage === "flat") this.err(s, `struct ${name}: mainField needs storage: node (a flat struct is already on the owner)`);
      if (!(s.mainField in fields)) this.err(s, `struct ${name}: mainField ${s.mainField} is not a field`);
    }
  }

  private includesCycle(name: string): boolean {
    const stack = [name];
    const seen = new Set<string>();
    while (stack.length) {
      for (const inc of this.structs[stack.pop()!]?.includes ?? []) {
        if (inc === name) return true;
        if (!seen.has(inc)) { seen.add(inc); stack.push(inc); }
      }
    }
    return false;
  }

  private validateProps(owner: string, el: El, props: Record<string, unknown>) {
    for (const [pname, spec] of entries(props)) {
      const p = normSpec(spec);
      const where = `${owner}.${pname}`;
      if (!CAMEL.test(pname)) this.err(el, `${where} must be camelCase`);
      for (const k of Object.keys(p)) if (!PROP_KEYS.has(k)) this.err(el, `${where} has unknown key '${k}'`);
      if (("type" in p) === ("struct" in p)) { this.err(el, `${where} needs exactly one of type or struct`); continue; }
      if (p.type !== undefined && !validType(normType(p.type))) this.err(el, `${where} has invalid type ${JSON.stringify(p.type)}`);
      if (p.derived) {
        if (p.struct || p.required || p.multi) this.err(el, `${where}: derived properties take a type only (no struct/required/multi)`);
        this.checkFragment(el, where, p.derived);
      }
      if (p.struct) {
        const s = this.structs[p.struct];
        if (!s) { this.err(el, `${where} uses unknown struct ${p.struct}`); continue; }
        this.checkDep(el, "structs", p.struct);
        const node = (s.storage ?? "flat") === "node";
        if ((p.multi || p.reducers || p.rel) && !node) this.err(el, `${where}: multi/reducers/rel need a struct with storage: node`);
        if (p.multi && s.mainField && !p.reducers) this.err(el, `${where}: multi-valued struct with a mainField needs reducers to pick the main value`);
        const fields = this.structFields(p.struct);
        for (const r of p.reducers ?? []) {
          if (!(r.field in fields)) this.err(el, `${where}: reducer field ${r.field} is not a field of ${p.struct}`);
          if (r.pick !== "max" && r.pick !== "min") this.err(el, `${where}: reducer pick must be max or min`);
        }
      } else if (p.multi || p.reducers) {
        this.err(el, `${where}: multi/reducers apply to struct properties only (use LIST<...> for scalar lists)`);
      }
    }
  }

  private checkFragment(el: El, where: string, cypher: string) {
    if (!/\bthis\b/.test(cypher)) this.err(el, `${where}: Cypher must refer to the owner as \`this\``);
    const labels = this.knownLabels();
    const rels = this.knownRels();
    for (const lab of matches(LABEL_IN_PATTERN, cypher)) {
      if (!labels.has(lab)) this.err(el, `${where}: Cypher uses unknown label :${lab}`);
    }
    for (const rel of matches(REL_IN_PATTERN, cypher).flatMap((g) => g.split("|")).filter(Boolean)) {
      if (!rels.has(rel)) this.err(el, `${where}: Cypher uses unknown relationship :${rel}`);
    }
    for (const clause of cypher.split(/\b(?:MATCH|MERGE|CREATE|WITH|RETURN|COUNT|COLLECT|EXISTS)\b/i)) {
      const found = matches(REL_IN_PATTERN, clause).flatMap((g) => g.split("|")).filter(Boolean);
      for (const rel of uniq(found.filter((r, i) => found.indexOf(r) !== i))) {
        this.warn(el, `${where}: one pattern traverses :${rel} twice; Cypher never reuses a relationship within a ` +
          `pattern, so a self-loop or back-and-forth hop is silently skipped. Split it into two MATCH clauses.`);
      }
    }
  }

  private validateInterface(name: string, i: El) {
    for (const parent of i.extends ?? []) {
      if (!this.interfaces[parent]) this.err(i, `interface ${name} extends unknown interface ${parent}`);
      this.checkDep(i, "interfaces", parent);
    }
    if (this.interfaceAncestors(name).includes(name)) this.err(i, `interface ${name} has an extends cycle`);
    this.validateProps(name, i, i.properties);
    this.checkConflicts(name, i, [...this.interfaceAncestors(name), name]);
  }

  private checkConflicts(owner: string, el: El, sources: string[]) {
    const seen = new Map<string, [string, string]>();
    for (const src of sources) {
      for (const [pname, p] of Object.entries(this.ownProps(src))) {
        const sig = stable([normType(p.type), p.struct ?? null, !!p.multi]);
        const prev = seen.get(pname);
        if (prev && prev[1] !== sig) this.err(el, `${owner}.${pname}: ${src} declares it differently from ${prev[0]}`);
        if (!prev) seen.set(pname, [src, sig]);
      }
    }
  }

  private validateType(name: string, t: El) {
    for (const i of t.implements ?? []) {
      if (!this.interfaces[i]) this.err(t, `${name} implements unknown interface ${i}`);
      this.checkDep(t, "interfaces", i);
    }
    if (!["normal", "hidden"].includes(t.visibility ?? "normal")) this.err(t, `${name}: visibility must be normal or hidden`);
    this.validateProps(name, t, t.properties);
    this.checkConflicts(name, t, [...this.typeInterfaces(name).reverse(), name]);
    const props = this.props(name);
    if (!t.key) this.err(t, `${name} needs a key`);
    else if (!props[t.key] || props[t.key].derived || props[t.key].struct) this.err(t, `${name}: key ${t.key} must be a stored scalar property`);
    const res = t.resolution;
    if (!res) return;
    const obs = res.observations;
    if (!this.types[obs]) this.err(t, `${name}.resolution: unknown observation type ${obs}`);
    for (const [k, from, to] of [["observationLink", obs, name], ["resolvedLink", name, name]]) {
      const l = this.links[res[k]];
      if (!l) this.err(t, `${name}.resolution.${k}: unknown link ${res[k]}`);
      else if (l.from !== from || l.to !== to) this.err(t, `${name}.resolution.${k} must go from ${from} to ${to}`);
    }
    if (this.types[obs] && this.types[obs].visibility !== "hidden") this.warn(t, `${name}: observation type ${obs} should be visibility: hidden`);
  }

  private validateLink(name: string, l: El) {
    for (const end of ["from", "to"]) {
      if (!this.labelExists(l[end])) this.err(l, `link ${name}.${end}: unknown type or interface ${l[end]}`);
      else this.checkDep(l, l[end] in this.types ? "objectTypes" : "interfaces", l[end]);
    }
    if (!CARDINALITIES.has(l.cardinality ?? "many-to-many")) this.err(l, `link ${name}: cardinality must be one of ${[...CARDINALITIES].join(", ")}`);
    for (const [pname, spec] of entries(l.properties)) {
      const p = normSpec(spec);
      const extra = Object.keys(p).some((k) => !["type", "required", "description"].includes(k));
      if (!CAMEL.test(pname) || extra || !validType(normType(p.type))) {
        this.err(l, `link ${name}.${pname}: link properties must be camelCase with a scalar type`);
      }
    }
    const b = l.backedBy;
    if (!b) return;
    if (!this.types[b.via]) this.err(l, `link ${name}.backedBy.via: unknown type ${b.via}`);
    else if (this.types[b.via].visibility !== "hidden") this.warn(l, `link ${name}: helper type ${b.via} should be visibility: hidden`);
    for (const [k, end] of [["fromLink", "from"], ["toLink", "to"]]) {
      const bl = this.links[b[k]];
      if (!bl) this.err(l, `link ${name}.backedBy.${k}: unknown link ${b[k]}`);
      else if (bl.from !== b.via || bl.to !== l[end]) this.err(l, `link ${name}.backedBy.${k} must go from ${b.via} to ${l[end]}`);
    }
  }

  private validateAction(name: string, a: El) {
    const target = a.target;
    if (!this.labelExists(target)) { this.err(a, `action ${name}: unknown target ${target}`); return; }
    const props = this.props(target);
    const stored = new Set(this.storedKeys(target));
    const writes: string[] = a.writes ?? [];
    for (const w of writes) {
      const p = props[w];
      if (!p) this.err(a, `action ${name} writes ${w}, which ${target} does not declare`);
      else if (p.derived) this.err(a, `action ${name} writes derived property ${w} (derived properties are read-only)`);
      else if (this.isNodeStruct(p) && this.structs[p.struct!].mainField) this.err(a, `action ${name} writes main field ${w}; write the ${p.struct} value nodes instead`);
      else if (!stored.has(w) && !this.isNodeStruct(p)) this.err(a, `action ${name} writes ${w}, which is not stored on ${target}`);
    }
    const cy: string = a.cypher ?? "";
    if (!cy) this.err(a, `action ${name} needs cypher`);
    else {
      this.checkFragment(a, `action ${name}`, cy);
      const allowed = new Set(writes.flatMap((w) => {
        const p = props[w];
        return p?.struct ? Object.keys(this.structFields(p.struct)).map((f) => `${w}_${f}`) : [w];
      }));
      for (const w of matches(/\bthis\.(\w+)\s*=/g, cy)) {
        if (!allowed.has(w)) this.err(a, `action ${name} sets this.${w} but does not list it in writes`);
      }
    }
    const params = a.params ?? {};
    for (const [pname, t] of entries(params)) {
      if (!validType(normType(t))) this.err(a, `action ${name} param ${pname} has invalid type ${JSON.stringify(t)}`);
    }
    for (const used of uniq(matches(/\$(\w+)/g, cy)).sort()) {
      if (!(used in params)) this.err(a, `action ${name} uses $${used} but does not declare it in params`);
    }
  }

  private validateSecurity(file: string, sec: any) {
    const roles = sec.roles ?? {};
    (sec.rules ?? []).forEach((r: any, i: number) => {
      const where = `${file}: security.rules[${i}]`;
      const verbs = ["grant", "deny"].filter((k) => k in r);
      if (verbs.length !== 1 || !["traverse", "read", "match"].includes(r[verbs[0]])) {
        this.errors.push(`${where}: needs exactly one of grant/deny with traverse, read or match`);
      }
      if (!(r.role in roles)) this.errors.push(`${where}: role ${r.role} is not declared in security.roles`);
      let fields: Set<string>;
      if (this.labelExists(r.type)) fields = new Set([...this.storedKeys(r.type), ...Object.keys(this.props(r.type))]);
      else if (this.structs[r.type]?.storage === "node") fields = new Set(Object.keys(this.structFields(r.type)));
      else { this.errors.push(`${where}: unknown type ${r.type}`); return; }
      for (const p of r.properties ?? []) if (!fields.has(p)) this.errors.push(`${where}: ${r.type} has no property ${p}`);
      const w = Object.keys(r.where ?? {});
      if (w.length > 1) this.errors.push(`${where}: Neo4j property rules take one property comparison`);
      for (const p of w) if (!fields.has(p)) this.errors.push(`${where}: where-property ${p} not on ${r.type}`);
    });
  }

  private ruleOfThree() {
    const sigTypes = new Map<string, Set<string>>();
    for (const [t, body] of Object.entries(this.types)) {
      for (const [pname, p] of Object.entries(this.ownProps(t))) {
        if (pname === body.key || p.derived) continue;
        const sig = stable([pname, normType(p.type), p.struct ?? null]);
        if (!sigTypes.has(sig)) sigTypes.set(sig, new Set());
        sigTypes.get(sig)!.add(t);
      }
    }
    const sigs = [...sigTypes.keys()];
    const reported = new Set<string>();
    for (let i = 0; i < sigs.length; i++) {
      for (let j = i + 1; j < sigs.length; j++) {
        const shared = [...sigTypes.get(sigs[i])!].filter((t) => sigTypes.get(sigs[j])!.has(t)).sort();
        const key = shared.join(",");
        if (shared.length < 3 || reported.has(key)) continue;
        reported.add(key);
        const common = sigs.filter((s) => shared.every((t) => sigTypes.get(s)!.has(t))).map((s) => JSON.parse(s)[0]).sort();
        this.warnings.push(`rule of three: ${shared.join(", ")} each declare ${common.join(", ")} directly; consider an interface`);
      }
    }
  }

  private compositionSmell() {
    const names = [...Object.keys(this.interfaces), ...Object.keys(this.types)];
    for (const [n, body] of Object.entries(this.interfaces)) {
      if (n.slice(1).includes("And")) {
        this.warn(body, `interface ${n} looks like a combination; prefer separate interfaces composed by implements`);
        continue;
      }
      for (const a of names) for (const b of names) {
        if (a !== b && a.length > 2 && b.length > 2 && n === a + b) {
          this.warn(body, `interface ${n} = ${a} + ${b}; prefer implements: [${a}, ${b}]`);
        }
      }
    }
  }

  // ---------- lock (closed for modification) ----------
  signature(kind: Kind, name: string): Record<string, unknown> {
    const sig: Record<string, any> = {};
    for (const [k, v] of Object.entries(this.el[kind][name])) {
      if (k.startsWith("_") || k === "description") continue;
      sig[k] = ["properties", "fields", "params"].includes(k)
        ? Object.fromEntries(entries(v).map(([pk, pv]) => {
          const { description: _d, ...rest } = normSpec(pv);
          return [pk, rest];
        }))
        : v;
    }
    return JSON.parse(stable(sig));
  }

  coreSnapshot(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const kind of KINDS) {
      for (const [n, el] of Object.entries(this.el[kind])) if (el._status === "core") out[`${kind}.${n}`] = this.signature(kind, n);
    }
    return out;
  }

  diffLock(lockPath: string, allowBreaking: boolean) {
    if (!existsSync(lockPath)) { this.notes.push(`no ${LOCK_FILE}; run \`lock\` to baseline the core modules`); return; }
    const old = JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, Record<string, any>>;
    const now = this.coreSnapshot() as Record<string, Record<string, any>>;
    const breaking: string[] = [];
    const additive: string[] = [];
    for (const [key, o] of Object.entries(old)) {
      const n = now[key];
      if (!n) { breaking.push(`${key} removed`); continue; }
      for (const k of uniq([...Object.keys(o), ...Object.keys(n)])) {
        const ov = o[k], nv = n[k];
        if (stable(ov) === stable(nv)) continue;
        if (["properties", "fields", "params"].includes(k) && ov && nv) {
          for (const pk of uniq([...Object.keys(ov), ...Object.keys(nv)])) {
            if (!(pk in nv)) breaking.push(`${key}.${pk} removed`);
            else if (!(pk in ov)) (nv[pk].required ? breaking : additive).push(`${key}.${pk} added${nv[pk].required ? " as required" : ""}`);
            else if (stable(ov[pk]) !== stable(nv[pk])) breaking.push(`${key}.${pk} changed ${stable(ov[pk])} -> ${stable(nv[pk])}`);
          }
        } else if (Array.isArray(ov) && Array.isArray(nv) && ov.every((x) => nv.includes(x))) {
          additive.push(`${key}.${k} added ${stable(nv.filter((x) => !ov.includes(x)))}`);
        } else {
          breaking.push(`${key}.${k} changed ${stable(ov)} -> ${stable(nv)}`);
        }
      }
    }
    additive.push(...Object.keys(now).filter((k) => !(k in old)).map((k) => `${k} added`));
    for (const msg of breaking) (allowBreaking ? this.warnings : this.errors).push(`core modified (breaking): ${msg}`);
    for (const msg of additive) this.notes.push(`core extended: ${msg}`);
  }
}

// ---------- generation ----------
function orderBy(v: string, reducers: Reducer[] | undefined): string {
  const keys = (reducers ?? []).flatMap((r) => [`${v}.${r.field} IS NULL`, `${v}.${r.field} ${r.pick === "max" ? "DESC" : "ASC"}`]);
  return keys.length ? ` ORDER BY ${keys.join(", ")}` : "";
}

function genSchema(o: Ontology, edition: string): string {
  const ee = edition === "enterprise";
  const out = [`// Generated by ontology.ts (${edition} edition). Do not edit.`, ""];
  const contract = (label: string, pname: string, type: string, required: boolean | undefined) => {
    const base = `${snake(label)}_${snake(pname)}`;
    if (required && ee) out.push(`CREATE CONSTRAINT ${base}_exists IF NOT EXISTS FOR (n:${label}) REQUIRE n.${pname} IS NOT NULL;`);
    if (ee) out.push(`CREATE CONSTRAINT ${base}_type IF NOT EXISTS FOR (n:${label}) REQUIRE n.${pname} IS :: ${cypherType(type)};`);
    if (type === "POINT") out.push(`CREATE POINT INDEX ${base}_point IF NOT EXISTS FOR (n:${label}) ON (n.${pname});`);
  };
  const ownContracts = (label: string, props: unknown) => {
    for (const [pname, spec] of entries(props)) {
      const p = normSpec(spec);
      if (p.derived) continue;
      if (!p.struct) { contract(label, pname, normType(p.type), p.required); continue; }
      const s = o.structs[p.struct];
      const fields = o.structFields(p.struct);
      if ((s.storage ?? "flat") === "flat") {
        for (const [f, fs] of Object.entries(fields)) contract(label, `${pname}_${f}`, normType(fs.type), p.required && fs.required);
      } else if (s.mainField) {
        contract(label, pname, normType(fields[s.mainField].type), false);
      }
    }
  };
  for (const [name, t] of Object.entries(o.types)) {
    out.push(`// ${name}`,
      `CREATE CONSTRAINT ${snake(name)}_key IF NOT EXISTS FOR (n:${name}) REQUIRE n.${t.key} ${ee ? "IS NODE KEY" : "IS UNIQUE"};`);
    ownContracts(name, t.properties);
    out.push("");
  }
  for (const [name, i] of Object.entries(o.interfaces)) {
    out.push(`// interface ${name}`);
    ownContracts(name, i.properties);
    out.push("");
  }
  for (const [name, s] of Object.entries(o.structs)) {
    if (s.storage !== "node") continue;
    out.push(`// struct ${name} (value nodes)`);
    for (const [f, fs] of Object.entries(o.structFields(name))) contract(name, f, normType(fs.type), fs.required);
    out.push("");
  }
  for (const [name, l] of Object.entries(o.links)) {
    for (const [pname, spec] of entries(l.properties)) {
      const p = normSpec(spec);
      const base = `${snake(name)}_${snake(pname)}`;
      if (ee && p.required) out.push(`CREATE CONSTRAINT ${base}_exists IF NOT EXISTS FOR ()-[r:${name}]-() REQUIRE r.${pname} IS NOT NULL;`);
      if (ee) out.push(`CREATE CONSTRAINT ${base}_type IF NOT EXISTS FOR ()-[r:${name}]-() REQUIRE r.${pname} IS :: ${cypherType(normType(p.type))};`);
    }
  }
  return out.join("\n").trimEnd() + "\n";
}

function genLint(o: Ontology): string {
  const out = ["// Generated by ontology.ts. Every statement returns (check, detail, violations); all zero or no rows means clean.", ""];
  const q = (comment: string, body: string) => out.push(`// ${comment}`, body.trim() + ";", "");

  for (const t of Object.keys(o.types)) {
    const labels = o.labels(t).slice(1);
    if (!labels.length) continue;
    q(`${t} carries all its interface labels`,
      `MATCH (n:${t}) WHERE NOT (${labels.map((l) => `n:${l}`).join(" AND ")})\n` +
      `RETURN 'label-completeness' AS check, '${t}' AS detail, count(n) AS violations`);
  }
  for (const i of Object.keys(o.interfaces)) {
    const cond = o.implementers(i).map((t) => `n:${t}`).join(" OR ") || "false";
    q(`every :${i} node is a concrete implementing type`,
      `MATCH (n:${i}) WHERE NOT (${cond})\nRETURN 'abstract-node' AS check, '${i}' AS detail, count(n) AS violations`);
  }
  const known = [...o.knownLabels()].sort().map(literal).join(", ");
  q("no labels outside the ontology",
    `MATCH (n) UNWIND labels(n) AS l WITH l WHERE NOT l IN [${known}]\nRETURN 'unknown-label' AS check, l AS detail, count(*) AS violations`);
  const rels = [...o.knownRels()].sort().map(literal).join(", ");
  q("no relationship types outside the ontology",
    `MATCH ()-[r]->() WITH type(r) AS t WHERE NOT t IN [${rels}]\nRETURN 'unknown-relationship' AS check, t AS detail, count(*) AS violations`);

  const valueStructs = Object.entries(o.structs).filter(([, b]) => b.storage === "node").map(([s]) => s);
  for (const owner of [...Object.keys(o.types), ...valueStructs]) {
    // [key, type, required]; required === "rel" marks a required node-stored struct
    const checks: [string, string, boolean | "rel" | undefined][] = [];
    let stored: string[];
    if (owner in o.types) {
      for (const [pname, p] of Object.entries(o.props(owner))) {
        if (p.derived) continue;
        if (!p.struct) { checks.push([pname, normType(p.type), p.required]); continue; }
        const s = o.structs[p.struct];
        const fields = o.structFields(p.struct);
        if ((s.storage ?? "flat") === "flat") {
          for (const [f, fs] of Object.entries(fields)) checks.push([`${pname}_${f}`, normType(fs.type), p.required && fs.required]);
        } else if (s.mainField) {
          checks.push([pname, normType(fields[s.mainField].type), false]);
        }
        if (s.storage === "node" && p.required) {
          checks.push([`EXISTS { (n)-[:${o.structRel(pname, p)}]->(:${p.struct}) }`, "", "rel"]);
        }
      }
      stored = o.storedKeys(owner);
    } else {
      const fields = o.structFields(owner);
      for (const [f, fs] of Object.entries(fields)) checks.push([f, normType(fs.type), fs.required]);
      stored = Object.keys(fields);
    }
    const cases: string[] = [];
    for (const [key, type, req] of checks) {
      if (req === "rel") { cases.push(`CASE WHEN NOT ${key} THEN 'missing value node' END`); continue; }
      if (req) cases.push(`CASE WHEN n.${key} IS NULL THEN '${key} missing' END`);
      cases.push(`CASE WHEN n.${key} IS NOT NULL AND NOT n.${key} IS :: ${cypherType(type)} THEN '${key} not ${type}' END`);
    }
    if (cases.length) {
      q(`${owner} property contract (required + types)`,
        `MATCH (n:${owner})\nUNWIND [x IN [\n  ${cases.join(",\n  ")}\n] WHERE x IS NOT NULL] AS problem\n` +
        `RETURN 'property-contract' AS check, '${owner}.' + problem AS detail, count(*) AS violations`);
    }
    q(`${owner} has no undeclared properties`,
      `MATCH (n:${owner}) UNWIND keys(n) AS k WITH k WHERE NOT k IN [${stored.map(literal).join(", ")}]\n` +
      `RETURN 'undeclared-property' AS check, '${owner}.' + k AS detail, count(*) AS violations`);
  }

  const ownerRels = new Map<string, Set<string>>();
  for (const [owner, pname, p, s] of o.nodeStructUses()) {
    const rel = o.structRel(pname, p);
    if (!ownerRels.has(s)) ownerRels.set(s, new Set());
    ownerRels.get(s)!.add(rel);
    if (!p.multi) {
      q(`${owner}.${pname} is single-valued`,
        `MATCH (n:${owner}) WHERE COUNT { (n)-[:${rel}]->(:${s}) } > 1\n` +
        `RETURN 'struct-cardinality' AS check, '${owner}.${pname}' AS detail, count(n) AS violations`);
    }
    const main = o.structs[s].mainField;
    if (main) {
      q(`${owner}.${pname} main field is in sync with its value nodes (run refresh.cypher if not)`,
        `MATCH (n:${owner})\nWITH n, COLLECT { MATCH (n)-[:${rel}]->(v:${s}) RETURN v.${main}${orderBy("v", p.reducers)} LIMIT 1 }[0] AS expected\n` +
        `WHERE NOT coalesce(n.${pname} = expected, n.${pname} IS NULL AND expected IS NULL)\n` +
        `RETURN 'stale-main-field' AS check, '${owner}.${pname}' AS detail, count(n) AS violations`);
    }
  }
  for (const [s, relSet] of ownerRels) {
    q(`every :${s} value node has an owner`,
      `MATCH (v:${s}) WHERE NOT EXISTS { ()-[:${[...relSet].sort().join("|")}]->(v) }\n` +
      `RETURN 'orphan-value' AS check, '${s}' AS detail, count(v) AS violations`);
  }

  for (const [name, l] of Object.entries(o.links)) {
    const { from, to } = l;
    q(`${name} connects ${from} to ${to}`,
      `MATCH (a)-[r:${name}]->(b) WHERE NOT (a:${from} AND b:${to})\n` +
      `RETURN 'link-endpoints' AS check, '${name}' AS detail, count(r) AS violations`);
    const card = l.cardinality ?? "many-to-many";
    if (card === "many-to-one" || card === "one-to-one") {
      q(`${name}: each ${from} has at most one`,
        `MATCH (a:${from}) WHERE COUNT { (a)-[:${name}]->() } > 1\n` +
        `RETURN 'link-cardinality' AS check, '${name} out' AS detail, count(a) AS violations`);
    }
    if (card === "one-to-many" || card === "one-to-one") {
      q(`${name}: each ${to} has at most one`,
        `MATCH (b:${to}) WHERE COUNT { ()-[:${name}]->(b) } > 1\n` +
        `RETURN 'link-cardinality' AS check, '${name} in' AS detail, count(b) AS violations`);
    }
    const b = l.backedBy;
    if (b?.materialize) {
      q(`${name} shortcuts match their ${b.via} backing`,
        `MATCH (a:${from})<-[:${b.fromLink}]-(:${b.via})-[:${b.toLink}]->(b:${to})\nWHERE NOT EXISTS { (a)-[:${name}]->(b) }\n` +
        `RETURN 'backed-link-missing' AS check, '${name}' AS detail, count(*) AS violations`);
      q(`${name} has no shortcut without a backing ${b.via}`,
        `MATCH (a)-[r:${name}]->(b) WHERE NOT EXISTS { (a)<-[:${b.fromLink}]-(:${b.via})-[:${b.toLink}]->(b) }\n` +
        `RETURN 'backed-link-stale' AS check, '${name}' AS detail, count(r) AS violations`);
    } else if (b) {
      q(`${name} is backed by ${b.via} and must not be stored`,
        `MATCH ()-[r:${name}]->()\nRETURN 'backed-link-stored' AS check, '${name}' AS detail, count(r) AS violations`);
    }
  }

  for (const [name, t] of Object.entries(o.types)) {
    const res = t.resolution;
    if (!res) continue;
    const { resolvedLink: rl, observationLink: ol, observations: obs } = res;
    q(`every ${name} resolves to a canonical ${name}`,
      `MATCH (e:${name}) WHERE NOT EXISTS { (e)-[:${rl}]->(:${name}) }\n` +
      `RETURN 'unresolved-entity' AS check, '${name}' AS detail, count(e) AS violations`);
    q(`${rl} always points at a canonical ${name} (one hop, canonical points to itself)`,
      `MATCH (a:${name})-[:${rl}]->(b:${name}) WHERE a <> b AND NOT EXISTS { (b)-[:${rl}]->(b) }\n` +
      `RETURN 'resolution-chain' AS check, '${name}' AS detail, count(a) AS violations`);
    q(`every ${obs} belongs to a ${name}`,
      `MATCH (x:${obs}) WHERE NOT EXISTS { (x)-[:${ol}]->(:${name}) }\n` +
      `RETURN 'orphan-observation' AS check, '${obs}' AS detail, count(x) AS violations`);
  }
  return out.join("\n").trimEnd() + "\n";
}

function projection(o: Ontology, owner: string): string {
  const parts: string[] = [];
  for (const [pname, p] of Object.entries(o.props(owner))) {
    if (p.derived) { parts.push(`${pname}: ${oneLine(p.derived)}`); continue; }
    if (!p.struct) { parts.push(`.${pname}`); continue; }
    const s = o.structs[p.struct];
    const fields = Object.keys(o.structFields(p.struct));
    if ((s.storage ?? "flat") === "flat") {
      parts.push(`${pname}: {${fields.map((f) => `${f}: this.${pname}_${f}`).join(", ")}}`);
      continue;
    }
    const match = `MATCH (this)-[:${o.structRel(pname, p)}]->(v:${p.struct}) RETURN v {.*}${orderBy("v", p.reducers)}`;
    const all = `COLLECT { ${match} }`;
    const one = `COLLECT { ${match} LIMIT 1 }[0]`;
    if (s.mainField) parts.push(`.${pname}`, `${pname}Values: ${all}`);
    else if (p.multi && p.reducers) parts.push(`${pname}: ${one}`, `${pname}Values: ${all}`);
    else if (p.multi) parts.push(`${pname}: ${all}`);
    else parts.push(`${pname}: ${one}`);
  }
  return `this {\n  ${parts.join(",\n  ")}\n}`;
}

function genViews(o: Ontology): Record<string, string> {
  const views: Record<string, string> = {};
  for (const [name, t] of Object.entries(o.types)) {
    if (t.visibility === "hidden") continue;
    views[`${name}.cypher`] = `// View of one ${name}. Params: $${t.key}\n` +
      `MATCH (this:${name} {${t.key}: $${t.key}})\nRETURN ${projection(o, name)} AS ${lcFirst(name)}\n`;
  }
  for (const name of Object.keys(o.interfaces)) {
    const impl = o.implementers(name).map(literal).join(", ");
    views[`${name}.cypher`] = `// List any ${name} (covariant: works for every implementing type). Params: $skip, $limit\n` +
      `MATCH (this:${name})\nWITH this, [l IN labels(this) WHERE l IN [${impl}]][0] AS objectType\n` +
      `RETURN objectType, ${projection(o, name)} AS ${lcFirst(name)}\nSKIP $skip LIMIT $limit\n`;
  }
  return views;
}

function genRefresh(o: Ontology): string {
  const out = ["// Generated by ontology.ts. Recomputes materialised values. Safe to re-run. Requires Neo4j 5.23+ (scoped CALL).", ""];
  for (const [owner, pname, p, s] of o.nodeStructUses()) {
    const main = o.structs[s].mainField;
    if (!main) continue;
    out.push(`// ${owner}.${pname} <- main field ${s}.${main}`,
      `MATCH (n:${owner})\nCALL (n) {\n  OPTIONAL MATCH (n)-[:${o.structRel(pname, p)}]->(v:${s})\n` +
      `  RETURN v${orderBy("v", p.reducers)} LIMIT 1\n}\nSET n.${pname} = v.${main};`, "");
  }
  for (const [name, l] of Object.entries(o.links)) {
    const b = l.backedBy;
    if (!b?.materialize) continue;
    const path = `(a)<-[:${b.fromLink}]-(:${b.via})-[:${b.toLink}]->(b)`;
    out.push(`// ${name} shortcuts <- ${b.via}`,
      `MATCH (a:${l.from})<-[:${b.fromLink}]-(:${b.via})-[:${b.toLink}]->(b:${l.to})\nMERGE (a)-[:${name}]->(b);`,
      `MATCH (a)-[r:${name}]->(b)\nWHERE NOT EXISTS { ${path} }\nDELETE r;`, "");
  }
  return out.join("\n").trimEnd() + "\n";
}

function genActions(o: Ontology): Record<string, string> {
  const files: Record<string, string> = {};
  for (const [name, a] of Object.entries(o.actions)) {
    const params = entries(a.params).map(([p, t]) => `//   $${p}: ${normType(t)}`).join("\n") || "//   (none)";
    const accepts = o.implementers(a.target).join(", ") || a.target;
    files[`${name}.cypher`] = `// Action ${name}: ${a.description.trim()}\n// Target: ${a.target} (also accepts ${accepts})\n` +
      `// Writes: ${(a.writes ?? []).join(", ")}\n// Params:\n${params}\n${a.cypher.trim()}\n`;
  }
  return files;
}

function genSecurity(o: Ontology, graph: string): string {
  const out = ["// Generated by ontology.ts. Enterprise Edition only. Run against the system database.", ""];
  for (const [file, sec] of o.security) {
    out.push(`// from ${file}`);
    for (const [role, desc] of entries(sec.roles)) {
      out.push(`// ${role}: ${desc}`, `CREATE ROLE ${role} IF NOT EXISTS;`, `GRANT ACCESS ON DATABASE ${graph} TO ${role};`);
    }
    const granted = new Map<string, Set<string>>();
    for (const r of sec.rules ?? []) {
      const verb = "grant" in r ? "GRANT" : "DENY";
      const priv = String(r.grant ?? r.deny).toUpperCase();
      const props = (r.properties ?? []).flatMap((p: string) => {
        const spec = o.labelExists(r.type) ? o.props(r.type)[p] : undefined;
        return spec?.struct && (o.structs[spec.struct].storage ?? "flat") === "flat"
          ? Object.keys(o.structFields(spec.struct)).map((f) => `${p}_${f}`)
          : [p];
      });
      const seg = priv === "TRAVERSE" ? "" : ` {${props.join(", ") || "*"}}`;
      const w = entries(r.where);
      const target = w.length ? `FOR (n:${r.type}) WHERE n.${w[0][0]} = ${literal(w[0][1])}` : `NODES ${r.type}`;
      out.push(`${verb} ${priv}${seg} ON GRAPH ${graph} ${target} TO ${r.role};`);
      if (verb === "GRANT") {
        if (!granted.has(r.role)) granted.set(r.role, new Set());
        granted.get(r.role)!.add(r.type);
      }
    }
    for (const [role, types] of granted) {
      const reachable = new Set([...types].flatMap((t) => [t, ...(t in o.types ? o.typeInterfaces(t) : [])]));
      const rels = uniq([
        ...Object.entries(o.links).filter(([, l]) => reachable.has(l.from) && reachable.has(l.to)).map(([n]) => n),
        ...o.nodeStructUses().filter(([ow, , , s]) => reachable.has(ow) && reachable.has(s)).map(([, pn, p]) => o.structRel(pn, p)),
      ]).sort();
      for (const rel of rels) out.push(`GRANT MATCH {*} ON GRAPH ${graph} RELATIONSHIPS ${rel} TO ${role};`);
    }
    out.push("");
  }
  return out.join("\n").trimEnd() + "\n";
}

function genAgentSchema(o: Ontology): string {
  const suffix = (p: Spec) => (p.description ? ` — ${p.description}` : "");
  const propLine = (pname: string, p: Spec): string => {
    if (p.derived) {
      return `- \`${pname}\`: ${normType(p.type)}, **derived** (not stored; compute with \`${oneLine(p.derived)}\`, binding the node as \`this\`)${suffix(p)}`;
    }
    if (!p.struct) return `- \`${pname}\`: ${normType(p.type)}${p.required ? " (required)" : ""}${suffix(p)}`;
    const s = o.structs[p.struct];
    const fields = o.structFields(p.struct);
    let desc: string;
    if ((s.storage ?? "flat") === "flat") {
      desc = `struct stored as ${Object.keys(fields).map((f) => `\`${pname}_${f}\``).join(", ")}`;
    } else {
      desc = `${p.multi ? "many" : "one"} \`(:${p.struct})\` value node(s) via \`-[:${o.structRel(pname, p)}]->\``;
      if (s.mainField) desc = `${normType(fields[s.mainField].type)} (main value, stored); full history: ${desc}`;
    }
    return `- \`${pname}\`: ${desc}${suffix(p)}`;
  };
  const labelList = (t: string) => o.labels(t).map((l) => `:${l}`).join("");

  const out = ["# Graph schema", "", "Generated by ontology.ts. Do not edit.", "", "Query rules:",
    "- Match on the most general label that has the properties you need (an interface label matches every implementing type).",
    "- Derived properties are not stored. Inline the Cypher shown.",
    "- Nodes labelled `Helper` or `Value` are implementation detail. Traverse them only when you need to filter on their properties.",
    "- Change data only through the actions listed at the end.", "", "## Interfaces", ""];
  for (const [name, i] of Object.entries(o.interfaces)) {
    const ext = i.extends?.length ? ` Extends ${i.extends.join(", ")}.` : "";
    out.push(`### :${name}`, `${i.description.trim()}${ext} Implemented by: ${o.implementers(name).join(", ") || "none"}.`, "");
    out.push(...Object.entries(o.props(name)).map(([n, p]) => propLine(n, p)), "");
  }
  out.push("## Object types", "");
  for (const [name, t] of Object.entries(o.types)) {
    if (t.visibility === "hidden") continue;
    out.push(`### ${labelList(name)}`, t.description.trim(), "", `Key: \`${t.key}\``, "");
    out.push(...Object.entries(o.props(name)).map(([n, p]) => propLine(n, p)), "");
  }
  out.push("## Links", "");
  for (const [name, l] of Object.entries(o.links)) {
    let line = `- \`(:${l.from})-[:${name}]->(:${l.to})\` ${l.cardinality ?? "many-to-many"} — ${l.description.trim()}`;
    const b = l.backedBy;
    if (b) {
      line += ` Backed by \`(a)<-[:${b.fromLink}]-(:${b.via})-[:${b.toLink}]->(b)\`` +
        (b.materialize ? " (shortcut stored)." : "; query that path, the shortcut is not stored.");
    }
    out.push(line);
  }
  const hidden = Object.entries(o.types).filter(([, t]) => t.visibility === "hidden");
  if (hidden.length) {
    out.push("", "## Helper types", "");
    for (const [name, t] of hidden) {
      out.push(`- \`${labelList(name)}\` — ${t.description.trim()} Properties: ${o.storedKeys(name).map((k) => `\`${k}\``).join(", ")}.`);
    }
  }
  if (Object.keys(o.actions).length) {
    out.push("", "## Actions", "");
    for (const [name, a] of Object.entries(o.actions)) {
      const params = entries(a.params).map(([p, t]) => `${p}: ${normType(t)}`).join(", ");
      out.push(`- \`${name}(${params})\` on \`:${a.target}\` — ${a.description.trim()}`);
    }
  }
  return out.join("\n").trimEnd() + "\n";
}

function report(o: Ontology): number {
  for (const n of o.notes) console.log(`note: ${n}`);
  for (const w of o.warnings) console.log(`WARNING ${w}`);
  for (const e of o.errors) console.log(`ERROR ${e}`);
  console.log(`${o.errors.length} error(s), ${o.warnings.length} warning(s)`);
  return o.errors.length ? 1 : 0;
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string", default: "build" },
      edition: { type: "string", default: "enterprise" },
      graph: { type: "string", default: "neo4j" },
      "allow-breaking": { type: "boolean", default: false },
    },
  });
  const [command, dir] = positionals;
  if (!["check", "build", "lock"].includes(command) || !dir || !["enterprise", "community"].includes(values.edition!)) {
    console.error("usage: node ontology.ts {check|build|lock} DIR [--out build] [--edition enterprise|community] [--graph neo4j] [--allow-breaking]");
    process.exit(2);
  }

  const o = new Ontology(dir);
  const lockPath = join(dir, LOCK_FILE);
  if (command === "lock") {
    if (o.errors.length) process.exit(report(o));
    writeFileSync(lockPath, JSON.stringify(o.coreSnapshot(), null, 2) + "\n");
    console.log(`wrote ${lockPath}`);
    return;
  }
  if (!o.errors.length) o.diffLock(lockPath, values["allow-breaking"]!);
  const code = report(o);
  if (command === "check" || code) process.exit(code);

  const out = values.out!;
  const files: Record<string, string> = {
    "schema.cypher": genSchema(o, values.edition!),
    "lint.cypher": genLint(o),
    "refresh.cypher": genRefresh(o),
    "agent-schema.md": genAgentSchema(o),
  };
  if (values.edition === "enterprise" && o.security.length) files["security.cypher"] = genSecurity(o, values.graph!);
  for (const [k, v] of Object.entries(genViews(o))) files[`views/${k}`] = v;
  for (const [k, v] of Object.entries(genActions(o))) files[`actions/${k}`] = v;
  for (const sub of ["views", "actions"]) mkdirSync(join(out, sub), { recursive: true });
  for (const [rel, text] of Object.entries(files)) writeFileSync(join(out, rel), text);
  console.log(`wrote ${Object.keys(files).length} files to ${out}`);
}

main();
