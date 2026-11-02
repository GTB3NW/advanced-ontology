# DevCon talk example

A complete ontology built from the examples in Palantir's [Deep Dive: Advanced Ontology](https://www.youtube.com/watch?v=_b2qsKz_Ifk) (DevCon 5, 2026). Each module shows one pattern from the talk:

| Module | Pattern |
|---|---|
| `core/foundation.yaml` | shared structs (`Provenance`, flat `Address`, node-stored `Geolocation` with a main field) |
| `core/facilities.yaml` | interfaces and composition (`Arena implements [Building, SchedulableResource]`) |
| `core/events.yaml` | PECS: one `rescheduleEvent` action for every event type |
| `core/people.yaml` | derived properties (org chart) and an object-backed link (`VentureStaffing`) |
| `core/equipment.yaml` | non-destructive entity resolution with observations |
| `extensions/healthcare.yaml` | open/closed extension of `Building`, and security levels 1 to 3 |

`ontology.lock.json` is the locked baseline for the `core` modules. `seed.cypher` loads sample data.

## Run it

From the repository root:

```sh
npm install --prefix .claude/skills/neo4j-ontology/scripts
node .claude/skills/neo4j-ontology/scripts/ontology.ts check examples/devcon-talk
node .claude/skills/neo4j-ontology/scripts/ontology.ts build examples/devcon-talk --out build/
```

Against a Neo4j 5.6+ database, apply `build/schema.cypher`, then `seed.cypher`, then `build/refresh.cypher`, then run `build/lint.cypher`. Every lint row should report 0 violations. Apply `build/security.cypher` to the `system` database on Enterprise Edition, after which the `clinician` role sees one clinical note for patient `pk-4` (and reads `vip` as `NULL`), while the `psychiatry` role sees both.
