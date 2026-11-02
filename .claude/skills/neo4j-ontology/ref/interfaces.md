# Interfaces

An interface is a contract of properties that several object types share. In Neo4j it is an **extra label**: an `Arena` node is `:Arena:Building:SchedulableResource`. Workflows, views and actions written against `:Building` work for every implementer with no copies. Talk: [07:27](https://www.youtube.com/watch?v=_b2qsKz_Ifk&t=447s).

## When

- **Rule of three.** Three or more types declare the same properties directly, or the same workflow is about to be built a third time. `check` warns when three types share two or more identical properties.
- **A capability that cuts across types**, such as "schedulable", "geolocated" or "owned". Give each capability its own interface.

## Compose

```yaml
Arena:
  implements: [Building, SchedulableResource]   # composition
```
Each capability is a separate, small interface, and a type implements several of them. Avoid a combined interface such as `SchedulableBuilding`; `check` flags names that are two existing names joined together, or that contain `And`. Interfaces may `extends` other interfaces (multi-level). Implementers carry every ancestor label, and the `label-completeness` lint checks that.

## Producer extends, consumer super

- **Readers are covariant.** Write a read query against the most general label that has what it needs. `views/Building.cypher` lists every building and reports `objectType` so callers can branch.
- **Writers are contravariant.** An action whose target is `Event` accepts `NbaGame` and `DevConKeynote`. Give an action the most general target whose properties it writes.

## Open/closed

Core interfaces are locked by `ontology.lock.json`. Other teams extend them by adding object types in `extension` modules (for example, `Hospital implements Building` in a healthcare extension), never by editing the interface. Adding an *optional* property to a core interface is additive. Adding a required one breaks every existing implementer, which is why it is reported as breaking.

## Generated

- `schema.cypher`: existence and type constraints on the **interface** label. The contract is enforced on every implementer.
- `lint.cypher`: `label-completeness` (a type is missing an interface label) and `abstract-node` (a node has an interface label but no concrete type).
