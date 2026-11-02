# Derived properties

A derived property is a value computed from linked nodes. It is defined **once**, in the ontology, as Cypher that refers to the owner as `this`. Keep the data normalized. Copying a report's name onto a manager breaks when the name changes or a new report joins. Talk: [17:50](https://www.youtube.com/watch?v=_b2qsKz_Ifk&t=1070s).

```yaml
reportCount:
  type: INTEGER
  derived: "COUNT { (this)<-[:REPORTS_TO]-(:Employee) }"
reportNames:
  type: LIST<STRING>
  derived: "COLLECT { MATCH (this)<-[:REPORTS_TO]-(r:Employee) RETURN r.name ORDER BY r.name LIMIT 10 }"
```

Use `COUNT {}`, `COLLECT {}` and `EXISTS {}` subqueries. They need Neo4j 5.6 or later and fit inside a map projection. Talk aggregations map like this: *Count* → `COUNT {}`, *Collect list* plus a limit → `COLLECT { … LIMIT n }`, and a single linked value → `COLLECT { … LIMIT 1 }[0]`.

## How it is used

- The generated `views/<Type>.cypher` inlines the expression, so the value is always fresh.
- `agent-schema.md` shows the expression, so agents inline it too.
- Derived properties are read-only. `check` rejects an action that writes one.

## Multi-hop chains

The talk's derived properties traverse up to three links. In Cypher, **one pattern never reuses a relationship**. A chain that goes out and back along the same relationship type, such as `(this)-[:RESOLVED_TO]->(c)<-[:RESOLVED_TO]-(sibling)`, silently drops `this` itself, and drops everything else when there is a self-loop. Split the chain at the turn:

```cypher
COLLECT { MATCH (this)-[:RESOLVED_TO]->(c:Equipment)
          MATCH (c)<-[:RESOLVED_TO]-(:Equipment)<-[:OBSERVATION_OF]-(o) RETURN o.x }
```
`check` warns when one pattern names the same relationship type twice.

## Materialising (only when measured)

If a derived value must be sorted or filtered across millions of nodes, materialise it in a scheduled job. Declare it as a normal stored property, and record in its description which job writes it. Keep the original expression in a lint query that compares the two. Materialising is denormalizing, so do it only after a measurement shows it is needed.
