# Structs, reducers and main fields

A struct is one semantic property made of several fields, such as an address or a geolocation with provenance. Neo4j properties cannot hold maps, so a struct is stored either **flat** on the owner or as **value nodes**. Talk: [12:31](https://www.youtube.com/watch?v=_b2qsKz_Ifk&t=751s), reducers and main fields from [14:59](https://www.youtube.com/watch?v=_b2qsKz_Ifk&t=899s).

## Choose storage

| Need | storage | Graph |
|---|---|---|
| Fields belong together; one value; no per-value metadata | `flat` | `address_street`, `address_city` on the owner |
| Several values (history, several sources), metadata or provenance per value, security per value | `node` | `(owner)-[:HAS_ADDRESS]->(:Address:Value)` |
| LLM structured output (response, reasoning, source URLs) | `node` | one value node per answer, so reasoning and provenance stay queryable |

Reuse metadata by composing it: `includes: [Provenance]` adds `createdOn`, `createdBy`, `lastModifiedOn`, `lastModifiedBy`, `source` and `classification`. Metadata is relevant but not semantic. Keep it **next to the value**, in the struct, rather than in sidecar properties on the owner.

## Reducers: one value from many

```yaml
geolocation:
  struct: Geolocation
  multi: true
  reducers:
    - {field: lastModifiedOn, pick: max}   # newest first
    - {field: createdOn, pick: max}        # tie-break
```
Reducers become `ORDER BY v.f IS NULL, v.f DESC, … LIMIT 1`. The `IS NULL` key matters: in Cypher a null sorts *first* in descending order, so a value with no metadata would otherwise win. The generated view returns both the reduced value (`geolocation`) and the full history (`geolocationValues`). Searches and filters should use the history.

## Main field: the struct behaves like a plain value

`mainField: value` on the struct, combined with reducers on the property, means the owner holds `geolocation` as a plain `POINT`. It works in point indexes and `point.distance()`, and in any workflow that expects a point. The metadata stays one hop away.

- `refresh.cypher` recomputes it. Run it after every load, or call the same statement from the action that adds value nodes.
- The `stale-main-field` lint reports owners whose stored value differs from the reducer's choice.
- Actions write the **value nodes**, never the main field.

## Lint

- `orphan-value`: value nodes without an owner.
- `struct-cardinality`: more than one value node on a single-valued struct.
- `property-contract`: required fields and types on value nodes.
