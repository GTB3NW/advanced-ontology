# Advanced ontology for Neo4j

Claude Code skills for designing a Neo4j graph as an ontology: a model of the real world that people and agents can navigate, rather than a copy of the source datasets.

The approach comes from Palantir's talk **[Deep Dive: Advanced Ontology](https://www.youtube.com/watch?v=_b2qsKz_Ifk)** (Palantir Developers, DevCon 5, March 2026), presented by Landon Carter, group lead for Palantir's Ontology team. Its central claim is that ontology design is software design, judged by four principles: domain-driven design, don't repeat yourself (rule of three), open for extension and closed for modification, and producer extends, consumer super (PECS). These skills translate the talk's Foundry and Gotham features (interfaces, structs, reducers, main fields, derived properties, levels of security, entity resolution and object-backed links) into Neo4j.

## Contents

| Path | What it is |
|---|---|
| [`.claude/skills/neo4j-ontology/`](.claude/skills/neo4j-ontology/SKILL.md) | Ontology-as-code: a YAML format and a tool (`scripts/ontology.ts`) that checks it and generates constraints, lint queries, views, security rules, an agent schema and hexagonal TypeScript (domain types, ports, and a Neo4j adapter). One reference file per pattern in `ref/`. |
| [`.claude/skills/ontology-review/`](.claude/skills/ontology-review/SKILL.md) | A review checklist that applies the four principles to an ontology change or a data-model proposal. |
| [`examples/`](examples/) | Worked ontologies. [`devcon-talk/`](examples/devcon-talk/README.md) rebuilds every example from the talk. |

## Use

Copy `.claude/skills/` into your project (or into `~/.claude/skills/`), then install the tool's dependencies once:

```sh
npm install --prefix .claude/skills/neo4j-ontology/scripts
```

The tool needs Node 23.6 or later. Generated security rules need Neo4j Enterprise Edition; pass `--edition community` to skip them.

## Further reading

The talk recommends *Domain-Driven Design* (Eric Evans), *Clean Architecture* (Robert C. Martin) and *Effective Java* (Joshua Bloch).
