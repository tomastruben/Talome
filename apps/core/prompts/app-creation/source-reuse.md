# Source Reuse

Before generating from scratch, check whether the request can be built on top of a known source.

Source priority:
1. an explicit source chosen by the user
2. a strong match from Talome's app catalog
3. a public repository or template repository
4. a public compose example or image documentation
5. greenfield generation only when no strong base exists

When a source exists:
- reuse the proven parts
- keep provenance in the metadata
- state what was reused and what was changed
- do not discard a good source just to generate something novel

When working from a public repo:
- verify the exact URL, ref or commit, license, maintenance signal, stack compatibility, and self-hosting implications
- preserve its useful structure
- adapt it to Talome's conventions
- only replace parts that materially improve fit, quality, or consistency
- record the exact reused files, components, or patterns and any required attribution

Do not treat a GitHub search result as approved source code. Research candidates first and choose one of: reuse, adapt, visual inspiration only, or reject. Never fabricate repository facts when network access is unavailable.
