# Ontology YAML format

An ontology is a directory of `.yaml` files, one **module** per file. `ontology.ts` loads every file under the directory recursively and treats them as one namespace: every name is unique across all modules. A complete worked example lives in the repository's `examples/` folder.

## Module

```yaml
module: core.facilities        # required, dotted name
status: core                   # core | extension (default extension)
owner: ontology-platform       # team that approves changes
description: ...
structs: {}
interfaces: {}
objectTypes: {}
linkTypes: {}
actions: {}
security: {}
```

- **core** modules are closed for modification. `ontology.lock.json` records their shape. Removing or changing anything in them is a *breaking* error until someone runs `lock` again. Adding optional properties, new elements or extra `implements` is additive and allowed.
- **extension** modules add types, interfaces and links that build on core. Core elements may not reference extension elements, so dependencies always point toward core.
- Unknown keys anywhere are errors. This catches typos.

## Naming

| Element | Case | Neo4j form |
|---|---|---|
| struct, interface, objectType | PascalCase | label |
| linkType | UPPER_SNAKE_CASE | relationship type |
| property, struct field, action | camelCase | property key |

`Helper` and `Value` are reserved labels. Every struct, interface, object type, link type and action needs a `description`. The descriptions are what agents read in `agent-schema.md`.

## Types

`STRING`, `INTEGER`, `FLOAT`, `BOOLEAN`, `DATE`, `LOCAL TIME`, `ZONED TIME`, `LOCAL DATETIME`, `ZONED DATETIME`, `DURATION`, `POINT`, or `LIST<one of those>`. These are Cypher's own type names, used in type constraints and `IS ::` checks.

## Properties

A property is either a type name (shorthand) or a map:

```yaml
properties:
  floors: INTEGER                          # shorthand
  name: {type: STRING, required: true}
  address: {struct: Address}               # struct-typed
  geolocation:
    struct: Geolocation                    # struct with storage: node
    multi: true                            # many value nodes
    reducers:                              # pick the main value; applied in order, later ones break ties
      - {field: lastModifiedOn, pick: max}
      - {field: createdOn, pick: min}
    rel: LOCATED_AT                        # optional; default HAS_<UPPER_SNAKE(name)>
  reportCount:
    type: INTEGER
    derived: "COUNT { (this)<-[:REPORTS_TO]-(:Employee) }"   # read-only, computed at query time
    description: Number of direct reports.
```

Keys: `type` | `struct` (exactly one), `required`, `description`, `multi`, `reducers`, `rel`, `derived`.

- `derived` is a Cypher expression that refers to the owner node as `this`. Labels and relationship types used in it must exist. Derived properties cannot be `required`, `multi` or struct-typed. No action may write them.
- `multi`, `reducers` and `rel` apply only to structs stored as nodes. For a list of scalars, use `type: LIST<STRING>`.

## Structs

```yaml
structs:
  Address:
    description: A postal address.
    storage: flat               # flat (default) | node
    fields:
      street: {type: STRING, required: true}
      city: STRING
  Geolocation:
    description: ...
    storage: node
    includes: [Provenance]      # copy another struct's fields (composition)
    mainField: value            # node storage only
    fields:
      value: {type: POINT, required: true}
```

| storage | On the graph | Use when |
|---|---|---|
| `flat` | Owner properties `address_street`, `address_city`, … | single-valued, no per-value metadata |
| `node` | `(owner)-[:HAS_X]->(:Struct:Value {...})` | multi-valued, carries provenance or classification, or needs its own security |

A required field on a flat struct is enforced only when the struct property itself is `required`.

`mainField` copies the main field of the value node chosen by the reducers onto the owner as a plain property named after the struct property. For example, `EquipmentObservation.geolocation` becomes a `POINT`. `refresh.cypher` maintains it, the `stale-main-field` lint checks it, and actions may not write it directly. A `multi` struct with a `mainField` must have `reducers`.

## Interfaces

```yaml
interfaces:
  Building:
    description: ...
    extends: [Asset]            # optional, multi-level, no cycles
    properties: {...}           # the contract every implementer carries
```

## Object types

```yaml
objectTypes:
  Arena:
    description: ...
    implements: [Building, SchedulableResource]
    key: arenaId                # stored scalar; NODE KEY (enterprise) / UNIQUE (community)
    visibility: hidden          # optional: helper type, gets the :Helper label, hidden from agent schema
    properties: {...}
    resolution:                 # optional, see resolution.md
      observations: EquipmentObservation
      observationLink: OBSERVATION_OF     # observation -> this type
      resolvedLink: RESOLVED_TO           # this type -> this type
```

A node carries its type label, every interface label (including inherited ones), and `Helper` if it is hidden. Redeclaring an inherited property with a different type or struct is an error.

## Link types

```yaml
linkTypes:
  HELD_AT:
    description: ...
    from: Event                 # object type or interface
    to: Building
    cardinality: many-to-one    # one-to-one | one-to-many | many-to-one | many-to-many (default)
    properties:                 # relationship properties: scalars only
      since: DATE
  WORKED_ON:
    description: ...
    from: Employee
    to: Venture
    backedBy:                   # object-backed link
      via: VentureStaffing      # helper type
      fromLink: STAFF_MEMBER    # via -> from
      toLink: STAFFED_VENTURE   # via -> to
      materialize: true         # keep a real shortcut relationship in sync (refresh.cypher)
```

## Actions

```yaml
actions:
  rescheduleEvent:
    description: ...
    target: Event               # prefer an interface (contravariant consumer)
    params: {id: STRING, newStart: ZONED DATETIME}
    writes: [startDateTime]     # every `this.x =` in the Cypher must be listed
    cypher: |
      MATCH (this:Event) WHERE elementId(this) = $id
      SET this.startDateTime = $newStart
```

The validator checks four things:
- every `writes` entry is declared on the target
- no derived or main-field property is written
- every `this.x =` in the Cypher is listed in `writes`
- every `$param` the Cypher uses is declared in `params`

## Security (Enterprise Edition)

```yaml
security:
  roles:
    clinician: Treats patients. Sees routine notes only.
  rules:
    - {role: clinician, grant: match, type: Patient}
    - {role: clinician, grant: match, type: ClinicalNote, where: {classification: routine}}
    - {role: clinician, deny: read, type: Patient, properties: [vip]}
```

- Each rule needs exactly one of `grant` or `deny`, with `traverse`, `read` or `match`.
- `type` is an object type, an interface, or a struct stored as nodes.
- `properties` limits the rule to certain properties. A flat struct property expands to all its fields.
- `where` takes **one** property comparison. This is a Neo4j limitation.

The generator also grants `MATCH` on relationship types whose endpoints the role can see.

## Commands

```bash
S=.claude/skills/neo4j-ontology/scripts/ontology.ts   # Node >= 23.6; npm install in scripts/ once
node $S check ontology/                       # validate + diff core against the lock
node $S build ontology/ --out build/ [--edition community] [--graph neo4j] [--allow-breaking]
node $S lock  ontology/                       # accept current core as the baseline
```

`build` writes:

| File | Run with | Purpose |
|---|---|---|
| `schema.cypher` | `cypher-shell -f` | key, existence and type constraints; point indexes |
| `security.cypher` | `cypher-shell -d system -f` | roles and privileges (enterprise only) |
| `refresh.cypher` | after loads, on a schedule | main fields and materialised backed links |
| `lint.cypher` | in CI against a loaded graph | every row is `(check, detail, violations)`; clean means no non-zero rows |
| `views/<Type>.cypher` | from the application | one projection per type or interface, with derived properties inlined |
| `actions/<name>.cypher` | from the application or as agent tools | the action catalogue |
| `agent-schema.md` | as the agent's prompt or MCP schema | the semantic surface; helpers summarised last |
