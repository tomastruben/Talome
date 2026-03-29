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
- preserve its useful structure
- adapt it to Talome's conventions
- only replace parts that materially improve fit, quality, or consistency
