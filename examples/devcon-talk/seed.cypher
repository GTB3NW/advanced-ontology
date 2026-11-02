// Sample data matching the talk's examples. Load after build/schema.cypher, then run build/refresh.cypher.

// Interfaces: three building types, Arena also schedulable
CREATE (:Restaurant:Building {restaurantId: 'r-1', name: 'Noma', cuisine: 'Nordic', address_street: 'Refshalevej 96', address_city: 'Copenhagen'})
CREATE (:OfficeBuilding:Building {officeBuildingId: 'o-1', name: 'Palantir Denver', floors: 8, address_street: '1200 17th St', address_city: 'Denver', address_state: 'CO'})
CREATE (arena:Arena:Building:SchedulableResource {arenaId: 'a-1', name: 'Ball Arena', capacity: 19520, bookingCalendarId: 'cal-ball', address_street: '1000 Chopper Cir', address_city: 'Denver'})
CREATE (:NbaGame:Event {gameId: 'g-1', title: 'Nuggets vs Lakers', startDateTime: datetime('2026-03-12T19:00:00-06:00'), homeTeam: 'Nuggets', awayTeam: 'Lakers'})-[:HELD_AT]->(arena)
CREATE (:DevConKeynote:Event {keynoteId: 'k-1', title: 'DevCon 5 Keynote', startDateTime: datetime('2026-03-10T09:00:00-06:00'), speaker: 'Landon Carter'});

// Derived properties: a lead with three reports
CREATE (lead:Employee {employeeId: 'e-0', name: 'Landon Carter', title: 'Group Lead', team: 'Ontology'})
WITH lead
UNWIND [['e-1', 'Peep 1', 'Ontology - Backend'], ['e-2', 'Peep 2', 'Ontology - Frontend'], ['e-3', 'Peep 3', 'Ontology - Search']] AS row
CREATE (:Employee {employeeId: row[0], name: row[1], title: 'Team Lead', team: row[2]})-[:REPORTS_TO]->(lead);

// Object-backed links: staffing periods
CREATE (v1:Venture {ventureId: 'v-1', name: 'Ontology'}), (v2:Venture {ventureId: 'v-2', name: 'Apollo'})
WITH v1, v2
MATCH (e:Employee {employeeId: 'e-0'})
CREATE (e)<-[:STAFF_MEMBER]-(:VentureStaffing:Helper {staffingId: 's-1', startDate: date('2019-01-01'), endDate: date('2022-06-30')})-[:STAFFED_VENTURE]->(v2)
CREATE (e)<-[:STAFF_MEMBER]-(:VentureStaffing:Helper {staffingId: 's-2', startDate: date('2022-07-01')})-[:STAFFED_VENTURE]->(v1);

// Entity resolution: B resolved to canonical A; four observations with their own classification
CREATE (a:Equipment {equipmentId: 'eq-A', name: 'Equipment A'}), (b:Equipment {equipmentId: 'eq-B', name: 'Equipment B'})
CREATE (a)-[:RESOLVED_TO]->(a), (b)-[:RESOLVED_TO]->(a)
WITH a, b
UNWIND [
  ['ob-A', 'radar', 'secret', 'eq-A', 55.69, 12.55],
  ['ob-B', 'ais', 'public', 'eq-A', 55.70, 12.56],
  ['ob-C', 'imagery', 'secret', 'eq-B', 55.71, 12.57],
  ['ob-D', 'ais', 'public', 'eq-B', 55.72, 12.58]
] AS row
MATCH (target:Equipment {equipmentId: row[3]})
CREATE (o:EquipmentObservation:Helper {observationId: row[0], source: row[1], classification: row[2]})-[:OBSERVATION_OF]->(target)
CREATE (o)-[:HAS_GEOLOCATION]->(:Geolocation:Value {value: point({latitude: row[4], longitude: row[5]}), source: row[1], classification: row[2], createdOn: datetime('2026-01-01T00:00:00Z'), lastModifiedOn: datetime('2026-01-01T00:00:00Z')})
CREATE (o)-[:HAS_GEOLOCATION]->(:Geolocation:Value {value: point({latitude: row[4] + 0.01, longitude: row[5]}), source: row[1], classification: row[2], createdOn: datetime('2026-02-01T00:00:00Z'), lastModifiedOn: datetime('2026-02-01T00:00:00Z')});

// Sub-cell security: each note is its own classified node
CREATE (h:Hospital:Building {hospitalId: 'h-1', name: 'Rigshospitalet', beds: 1100, address_street: 'Blegdamsvej 9', address_city: 'Copenhagen'})
WITH h
UNWIND [
  ['pk-1', 'James Holloway', 47, false, [['Annual checkup completed, vitals look normal.', 'routine'], ['Patient suspects spouse is poisoning him.', 'restricted']]],
  ['pk-2', 'Diana Mercer', 41, false, [['Flu shot administered, no adverse reaction.', 'routine']]],
  ['pk-3', 'Leo Vasquez', 24, false, [["Blood pressure slightly elevated, monitoring req'd.", 'routine'], ['Do not disclose diagnosis to family.', 'restricted']]],
  ['pk-4', 'Jordan Vale', 58, true, [['Routine labs ordered, fasting required beforehand.', 'routine'], ['Patient asked to keep weight off chart.', 'restricted']]]
] AS row
CREATE (p:Patient {patientId: row[0], name: row[1], age: row[2], vip: row[3]})-[:ADMITTED_TO]->(h)
WITH p, row
UNWIND row[4] AS note
CREATE (p)-[:HAS_NOTES]->(:ClinicalNote:Value {text: note[0], classification: note[1], createdOn: datetime()});
