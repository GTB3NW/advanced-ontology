# Entity resolution (non-destructive)

Several records describe one real-world thing. Resolve them **by adding links**, never by merging nodes. `apoc.refactor.mergeNodes` cannot be undone and loses each source's security. Talk: [21:33](https://www.youtube.com/watch?v=_b2qsKz_Ifk&t=1293s) (level 4 of the security section).

## Model

```yaml
Equipment:
  resolution: {observations: EquipmentObservation, observationLink: OBSERVATION_OF, resolvedLink: RESOLVED_TO}
EquipmentObservation:   # hidden, immutable, one per source record, carries its own classification
```
```
(:EquipmentObservation)-[:OBSERVATION_OF]->(:Equipment)
(a:Equipment)-[:RESOLVED_TO]->(a)          // canonical entity points to itself
(b:Equipment)-[:RESOLVED_TO]->(a)          // b resolved into a
```
- To resolve C, add `MERGE (c)-[:RESOLVED_TO]->(a)` after deleting C's old `RESOLVED_TO`. To un-resolve, point it back at itself.
- Every record points **directly** at the canonical entity (one hop). When canonicals merge, re-point every member of the losing group.

## Merged view (the talk's three-step chain)

```yaml
knownLocations:
  type: LIST<POINT>
  derived: >-
    COLLECT { MATCH (this)-[:RESOLVED_TO]->(canonical:Equipment)
    MATCH (canonical)<-[:RESOLVED_TO]-(:Equipment)<-[:OBSERVATION_OF]-(o:EquipmentObservation)-[:HAS_GEOLOCATION]->(g:Geolocation)
    RETURN g.value ORDER BY g.lastModifiedOn DESC LIMIT 10 }
```
The two `MATCH` clauses are required. Written as one pattern, Cypher refuses to reuse the `RESOLVED_TO` relationship it has just followed (or the canonical node's self-loop), and quietly drops that record's own observations. With security on the observation type, each caller's merged view contains only what they are cleared for.

## Lint

- `unresolved-entity`: a record has no `RESOLVED_TO`.
- `resolution-chain`: a record points at a non-canonical record (the target has no self-loop).
- `orphan-observation`: an observation is not attached to a record.
