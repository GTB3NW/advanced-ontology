# Actions

Every write is a named, parameterised action declared in the ontology. Scattered ad-hoc `SET` statements cannot be checked, so the only writes are the ones declared here.

```yaml
rescheduleEvent:
  description: Move any event to a new start time.
  target: Event                       # most general type whose properties it writes (contravariant)
  params: {id: STRING, newStart: ZONED DATETIME}
  writes: [startDateTime]
  cypher: |
    MATCH (this:Event) WHERE elementId(this) = $id
    SET this.startDateTime = $newStart
```

`check` enforces the following:
- `writes` lists only properties the target declares, and never derived or main-field properties.
- Every `this.x =` in the Cypher is listed in `writes`.
- Every `$param` is declared in `params`.
- Every label and relationship type used exists in the ontology.

An action that adds struct value nodes should also update the owner's main field, by repeating the statement from `refresh.cypher` for that owner. It should also add any required `RESOLVED_TO` or backed-link shortcut, so that the lint stays clean without a separate refresh.

## Agents

`build/actions/<name>.cypher` holds one parameterised statement per action. The header comment lists the params. Expose these as tools (for example through an MCP server), not raw write access. In TypeScript, `build/ts/ports.ts` declares every action as a typed method on `OntologyCommands`, and `commandCatalog` carries each action's description and param types for a driving adapter (such as an MCP server) to register tools from. `Neo4jOntology` in `build/ts/neo4j.ts` implements those methods. Read access can be text-to-Cypher over `build/agent-schema.md`.
