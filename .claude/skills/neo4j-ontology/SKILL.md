---
name: neo4j-ontology
description: Ontology-as-code for Neo4j. YAML modules generate constraints, lint, views, security and an agent schema. Use when designing or changing a Neo4j data model (object types, interfaces, links, structs, derived properties, security, entity resolution, actions), or when writing Cypher against an ontology-managed graph.
---

# Neo4j ontology

The ontology lives in YAML. The graph, its constraints and the schema agents read are all **generated** from it. Edit the YAML, never the generated Cypher. The design rules come from Palantir's [Deep Dive: Advanced Ontology](https://www.youtube.com/watch?v=_b2qsKz_Ifk) (DevCon 5, 2026): domain-driven design, DRY (rule of three), open/closed, and PECS (producer extends, consumer super).

- Format: [ref/format.md](ref/format.md)
- Tool: `node .claude/skills/neo4j-ontology/scripts/ontology.ts {check|build|lock} DIR`. It needs Node 23.6 or later. If `scripts/node_modules` is missing, run `npm install --prefix .claude/skills/neo4j-ontology/scripts` once.

## Steps

1. **Locate** the ontology directory: the folder holding `ontology.lock.json` or YAML files with a `module:` key. If there is none, create `ontology/` with `core/` and `extensions/` subfolders and start a `core` module there.
2. **Choose the pattern** for each change and read its file before editing:

   | The change involves | Read |
   |---|---|
   | shared shape across types, a workflow over several types, multiple inheritance | [ref/interfaces.md](ref/interfaces.md) |
   | grouped fields, per-value metadata or provenance, history, a "current" value | [ref/structs.md](ref/structs.md) |
   | a value computed from linked nodes (counts, lists, rollups) | [ref/derived.md](ref/derived.md) |
   | a relationship with its own data, or a join entity | [ref/links.md](ref/links.md) |
   | who can see which nodes, properties or list elements | [ref/security.md](ref/security.md) |
   | duplicate records of one real-world thing | [ref/resolution.md](ref/resolution.md) |
   | writing data, agent tools | [ref/actions.md](ref/actions.md) |

3. **Edit** the YAML. New work for another team goes in an `extension` module that implements core interfaces. Change a `core` module only when the core contract itself is wrong.
4. **Check**: `ontology.ts check DIR`. Done means **0 errors**, and every warning is either fixed or justified to the user in one line.
   - A `core modified (breaking)` error means the change modifies the closed core. Prefer an additive alternative such as a new interface, an optional property or an extension type. If the break is intended and the module owner agrees, re-run with `--allow-breaking`, then run `lock`.
5. **Build**: `ontology.ts build DIR --out build/` (add `--edition community` if the target lacks Enterprise features).
6. **Verify against a graph** if one is reachable: apply `schema.cypher`, then `refresh.cypher`, then run `lint.cypher`. Done means **every lint row reports 0 violations**. Run every generated view or action you touched once with real parameters.

## Writing Cypher against the graph

Read `build/agent-schema.md` first. It is the semantic surface:
- **Match interface labels** when the query only needs interface properties.
- **Inline derived properties** from their definition. They are not stored.
- **Treat `Helper` and `Value` nodes as plumbing.** Traverse them only to filter on their fields.
- **Write only through actions.**

A Cypher pattern never traverses the same relationship twice. Any path that goes out and back along one relationship type, such as resolution through a canonical self-loop, needs **two MATCH clauses**. `check` warns when a derived property or action breaks this rule.
