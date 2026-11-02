---
name: ontology-review
description: Review a Neo4j ontology change or data-model proposal against domain-driven design, DRY, open/closed and PECS. Use when reviewing ontology YAML, a graph-model proposal, or before locking core modules.
---

# Ontology review

Judge whether a model is a **digital twin of the real world** that people and agents can navigate, rather than a mirror of the source datasets. The mechanical checks live in the `neo4j-ontology` tool. This review covers the judgement the tool cannot make. The four principles come from Palantir's [Deep Dive: Advanced Ontology](https://www.youtube.com/watch?v=_b2qsKz_Ifk) (DevCon 5, 2026), whose central claim is that ontology design is software design.

## Steps

1. **Scope.** List every changed or proposed element: structs, interfaces, object types, links, actions and security rules. For a diff, use `git diff` on the ontology directory. For a proposal, write it out as the YAML it implies (see `.claude/skills/neo4j-ontology/ref/format.md`).
2. **Mechanical pass.** If the YAML exists, run `node .claude/skills/neo4j-ontology/scripts/ontology.ts check DIR`. Carry every error and warning into the findings, then stop re-checking what the tool already enforces.
3. **Judgement pass.** Apply **every rule below to every element in scope**. The step is done when each element has been assessed against each rule, including rules that pass.
4. **Report** findings grouped by principle, most severe first. Each finding gives `file:line`, the element, the rule, what to change (as concrete YAML), and a severity:
   - **block**: wrong model; changing it later breaks consumers
   - **fix**: should change before lock
   - **consider**: judgement call; state the trade-off

   End with a one-line verdict. When the elements are core, also say whether the change is ready to `lock`.

## Rules

### 01 Domain-driven design
- **Real-world nouns.** Every type, interface and link names something a domain expert would say. Flag names that mirror a source, such as `SapMaterialRow`, `crm_contact_v2`, `JoinTable`, `Staging*` or a column-shaped name like `cust_nm`. The talk calls this the "click next, next, ontologize" anti-pattern.
- **One-to-one twin.** One real-world thing is one type. Flag a single concept split across types by source system (use observations plus resolution instead), and a type that bundles two concepts.
- **Semantic links.** A link's name reads as a sentence: `(Employee)-[:REPORTS_TO]->(Employee)`. Flag generic names such as `RELATED_TO`, `HAS`, `LINK`, or names derived from a foreign key such as `HAS_FK_VENTURE_ID`.
- **Hidden plumbing.** Join entities, source records and metadata holders are `visibility: hidden` or `storage: node` structs, unless users talk about them as things in their own right.
- **Agent-legible descriptions.** Each description says what the thing *is* in the domain and how it differs from its neighbours. Flag descriptions that only repeat the name.
- **Semantic security.** Roles and classifications use domain words (`clinician`, `restricted`), not system groups.

### 02 Don't repeat yourself
- **Rule of three.** Three or more types share a shape or a workflow, so extract an interface. Two is fine.
- **Normalized data.** No value is copied from a linked node. Flag stored counts, names or rollups that should be `derived`.
- **One canonical type.** Flag near-duplicate types made for different teams or niches. Merge them, or put them behind one interface.
- **Metadata next to the value.** Provenance lives in the struct beside the value, not in sidecar properties (`addressSource`, `addressUpdatedAt`) on the owner.

### 03 Open for extension, closed for modification
- **Additive change.** A core change adds optional properties, new types or new `implements`. Flag removals, renames, type changes and new required properties on core elements; propose the additive route.
- **Extension placement.** One team's new types live in an `extension` module that implements core interfaces.
- **Composition.** Capabilities are small interfaces combined with `implements: [A, B]`. Flag combined interfaces such as `SchedulableBuilding`.
- **Stable contract.** A core interface carries only properties every implementer truly has. Flag a property that half the implementers would leave null.

### 04 Producer extends, consumer super (PECS)
- **Covariant reads.** Views and queries target the most general label that has the properties they read.
- **Contravariant writes.** An action's `target` is the most general type whose properties it writes. Flag `rescheduleKeynote` and `rescheduleGame` written separately where `rescheduleEvent` on `Event` would do.
- **Interface-typed links.** Link endpoints are interfaces when any implementer can take part, for example `HELD_AT` to `Building`.

### Modelling choices
- **Struct storage.** Use `flat` for a single value without metadata. Use `node` when there are several values, per-value metadata, or per-value security. Flag a `LIST<STRING>` whose elements need their own classification; it should be node structs.
- **Main fields and reducers.** A multi-valued property shown as one value has reducers that state the tie-break, and a `mainField` if workflows need it as a plain value.
- **Link versus node.** Link properties are fine for simple metadata. Flag link data that needs its own links, security or several instances; it should be an object-backed link.
- **Non-destructive resolution.** Duplicate records resolve through `resolution`, not merges. Observations are immutable and carry their own classification.
- **Derived chains.** Any derived property that goes out and back along one relationship type uses two MATCH clauses.
