# Experience and Screen Design

Design from use cases outward.

For each workflow, specify:

- the initiating user intent
- the smallest sequence of meaningful steps
- the system response after every consequential action
- the success state and a recovery path
- where the Talome Assistant can explain, suggest, or execute a safe action

For each screen, specify:

- the user job and linked use case
- one dominant action
- required information and its hierarchy
- the proven screen pattern being adapted
- preferred Talome/shadcn/Skiper/EvilCharts or researched component sources
- default, loading, empty, error, permission, and compact-window states as applicable

Avoid generic dashboard composition. Do not add KPI cards, charts, filters, badges, or navigation unless they help the named job. Prefer one strong visual or interactive focus over a grid of interchangeable cards. Use charts only for a decision the user needs to make; select the chart form from the question and data relationship.

Before implementation, lock:

- semantic color and spacing tokens
- typography and control density
- container model: open canvas, list, table, rail, panel, or a small number of purposeful cards
- icon family and treatment
- two to four signature component motifs
- motion cues and reduced-motion behavior

The result should feel Apple-like in clarity and restraint while remaining recognizably Talome: direct, calm, legible, self-hosted, and consistent across apps.
