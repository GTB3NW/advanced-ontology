# Levels of security

These features need Neo4j **Enterprise Edition**. In Community Edition, enforce the same rules in the API layer. `build` skips `security.cypher` when given `--edition community`. Talk: [19:33](https://www.youtube.com/watch?v=_b2qsKz_Ifk&t=1173s).

| Level | Model | Rule |
|---|---|---|
| 0, dataset | database access | `GRANT ACCESS` (generated per role) |
| 1, row | a node per record | `{role: r, grant: match, type: Patient, where: {classification: public}}`, or deny a whole type |
| 2, cell | a property on a node | `{role: r, deny: read, type: Patient, properties: [vip]}` |
| 3, sub-cell | **each list element is a value node** with its own `classification` | `{role: r, grant: match, type: ClinicalNote, where: {classification: routine}}` |
| 4, entity resolution | observations keep their own classification (see [resolution.md](resolution.md)) | row rules on the observation type |

## Sub-cell security

Model the list as a `storage: node` struct that includes `Provenance` (which supplies `classification`), then grant per classification. The generated view collects value nodes with `COLLECT {}`. Neo4j only returns the nodes the caller may traverse, so **the same view returns a different list for each role, with no application logic**.

## Rules of thumb

- Name roles and classifications in domain terms (`clinician`, `restricted`) so the security reads as the domain does.
- `where` takes one property comparison against a literal. Encode a compound policy as one classification property computed at load.
- A denied property reads as `NULL`, not as an error. Downstream code must treat `NULL` as "unknown or hidden", not as "false".
- The generator grants `MATCH` on relationship types between nodes a role can see. Without that grant, value nodes would be unreachable even when the nodes themselves are granted.
- Apply with `cypher-shell -d system -f build/security.cypher`.
