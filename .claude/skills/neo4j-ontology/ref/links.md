# Links and object-backed links

Talk: [23:08](https://www.youtube.com/watch?v=_b2qsKz_Ifk&t=1388s).

## Plain links

```yaml
REPORTS_TO: {description: ..., from: Employee, to: Employee, cardinality: many-to-one}
```
`from` and `to` may be interfaces, so a link from `Event` serves every event type. Lint checks endpoint labels (`link-endpoints`) and cardinality (`link-cardinality`).

## A relationship with data

Neo4j relationships carry properties, so simple link metadata stays on the link:
```yaml
properties: {since: DATE}
```
Store the association as a node **when it has its own identity**. That applies when it needs its own links, its own security, a lifecycle changed by actions, or several instances between the same pair of nodes (staffing periods, contracts, memberships).

## Object-backed link (reified association plus a direct link)

```yaml
VentureStaffing:                       # objectTypes
  visibility: hidden                   # helper: gets :Helper, summarised last in agent schema
  properties: {startDate: DATE, endDate: DATE}
STAFF_MEMBER:    {from: VentureStaffing, to: Employee}
STAFFED_VENTURE: {from: VentureStaffing, to: Venture}
WORKED_ON:
  from: Employee
  to: Venture
  backedBy: {via: VentureStaffing, fromLink: STAFF_MEMBER, toLink: STAFFED_VENTURE, materialize: true}
```
- Questions like "every venture this person has worked on" use `WORKED_ON`. The helper stays hidden.
- Questions like "the current venture" step through the helper and filter on its fields:
  ```cypher
  MATCH (e:Employee {employeeId: $id})<-[:STAFF_MEMBER]-(s:VentureStaffing)-[:STAFFED_VENTURE]->(v:Venture)
  WHERE s.startDate <= $asOf AND (s.endDate IS NULL OR s.endDate > $asOf)
  RETURN v
  ```
- `materialize: true`: `refresh.cypher` merges missing shortcuts and deletes stale ones. The lint checks `backed-link-missing` and `backed-link-stale`.
- `materialize: false`: the shortcut is never stored. Queries use the two-hop path, and the `backed-link-stored` lint catches stray copies.

Decide whether the join is semantic. If users talk about "a staffing", make it a visible type. If it is only plumbing, hide it.
