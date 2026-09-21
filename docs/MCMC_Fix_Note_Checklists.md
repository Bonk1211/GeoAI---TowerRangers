# MCMC compliance-audit checklists for ticket fix notes

Source: `docs/important/MCMC-MTSFB-TC-G041_2023-Radiocommunications-Network-Facilities-Compliance-Audit-for-Radiocommunications-Structure.pdf`
(MCMC MTSFB TC G041:2023) — Annex B (full audit checklist) and Annex C (sample internal-inspection
checklist template). This is the compliance-audit standard for radiocommunications structures; see
`CLAUDE.md`'s documentation map for how it relates to the Annex C factor set used elsewhere in the
project.

## Why this file exists

Ticket fix notes (`docs/Ticket_System_Handoff.md` `fix_notes[]`) are free text — a field-tech types
whatever they did. Nothing in the ticket system enforces a checklist; a field-tech can submit
`"replaced part"` and close the loop. These tables exist so a **field-tech or reviewer copies the
relevant table into the Jira ticket** (or the Fix Notes box) and ticks items off, rather than
inventing a checklist per ticket. This is a **reference document, not app code** — no
`issue_type` -> checklist mapping is wired into `src/frontend`; a person picks the table matching
the ticket's `issue_type`.

**These are compliance-audit inspection categories, not a repair manual.** Annex C tells an auditor
what to *look at* (earthing continuity, base plate condition, cable dressing); it does not diagnose
a specific fault. A tech still records what was actually wrong and what was actually done — the
table below is the scope of what to check, not a substitute for that sentence.

## How to use

1. Open the ticket's `issue_type` (Equipment / Power / Structural / Other — see
   `docs/Ticket_System_Handoff.md`).
2. Copy the matching table below into the Jira ticket description or the Fix Notes box.
3. Tick Y/N/N-A per row, add a one-line remark on any N.
4. Still write the actual fix as free text underneath — root cause, part replaced, test result.

---

## Equipment (Annex B §B.1.1 appurtenances/electrical, §6.1.3, §B.1.1.1 as applicable)

Covers active/passive equipment mounted on or feeding the structure — antennas, feed lines,
electrical components, generators.

| # | Item | Requirement | Y | N | N/A | Remark |
|---|---|---|---|---|---|---|
| 1 | Antenna & mount condition | No defects, deformation, loose/missing hardware | | | | |
| 2 | Feed line condition | Flanges/seals/jacket intact, properly secured, grounded | | | | |
| 3 | Electrical components | Comply with MCMC MTSFB TC G040 §7.1.2.1.10 | | | | |
| 4 | Earthing continuity | Resistance within max per G040 §7.1.2.2.4 | | | | |
| 5 | Earthing connections | Electrodes-to-earth connections intact, no corrosion | | | | |
| 6 | Lightning protection rod | Present at top of structure | | | | |
| 7 | Standby power (genset/rectifier) | Starts on test; battery, fuel, ATS/controller functional | | | | |
| 8 | Diesel/oil management | No leaks; managed to avoid scheduled waste (§6.3.2e) | | | | |
| 9 | Other appurtenances | Sensors, floodlights etc. secured, no loose hardware | | | | |

## Power (Annex B §6.1.3 electrical, §B.1.1 (b)/(c) as applicable)

| # | Item | Requirement | Y | N | N/A | Remark |
|---|---|---|---|---|---|---|
| 1 | Earthing system — copper tape | Corrosion-free | | | | |
| 2 | Earthing system — fasteners/connections | Tight and secure | | | | |
| 3 | Lightning arrestor | In tag, functional | | | | |
| 4 | Aviation light controller | Flasher / photo control / alarms functional | | | | |
| 5 | Electrical wiring | Weather-tight, secure, no damage | | | | |
| 6 | Power supply to active equipment | No fire-risk indicators (arcing, heat, burnt insulation) | | | | |

## Structural (Annex B §B.1.1 (a),(d),(g); Annex C §1, §5, §6, §7)

| # | Item | Requirement | Y | N | N/A | Remark |
|---|---|---|---|---|---|---|
| 1 | Members (legs, bracing) | No damaged/loose/missing members | | | | |
| 2 | Bolts & locking devices | No loose/missing | | | | |
| 3 | Welded connections | No visible cracks | | | | |
| 4 | Base plate | No cracks in base metal or plate stiffeners | | | | |
| 5 | Finishing | Paint/galvanising good, rust/corrosion-free | | | | |
| 6 | Foundation — ground condition | No settlement, movement, earth cracks, erosion | | | | |
| 7 | Foundation — concrete condition | No cracking, spalling, honeycombing | | | | |
| 8 | Anchorage | Nuts tight, locking device present, grout good | | | | |
| 9 | Climbing facilities & platform | Secured, in-tag | | | | |

## Other / Environment (Annex B §6.3, §B.1.3)

Use when the ticket doesn't fit Equipment/Power/Structural — vegetation, drainage, site condition,
vandalism.

| # | Item | Requirement | Y | N | N/A | Remark |
|---|---|---|---|---|---|---|
| 1 | Site drainage | Proper system, no blockage, smooth flow to disperse point | | | | |
| 2 | Soil condition | No major cracks, land subsidence, water ponding | | | | |
| 3 | Slope | Slope analysis on file if applicable | | | | |
| 4 | Vegetation | Grass cut ~1 m outside perimeter/fencing; slope turfing intact | | | | |
| 5 | Aesthetic / housekeeping | Minimised visual intrusion, no theft/vandalism risk | | | | |
| 6 | Site access | Logbook maintained, access process followed | | | | |

---

## Risk rating (Annex C, §5.2 / §7.4 of the technical code)

After the checklist, rate overall risk — carried over verbatim from Annex C, not this project's own
scale (do not confuse with the ML risk index's `risk`/`decision` bands, which are a different,
unrelated scoring system):

- **Low** — not likely to cause serious harm (e.g. blocked drainage, shrubs)
- **Moderate** — potential impact, not serious (e.g. bird nest, simple vandalism)
- **High** — likely to result in failure/harm (e.g. major equipment failure, vandalism, incompetency)
- **Extreme** — extreme damage/high consequence, low probability (e.g. natural disaster)
