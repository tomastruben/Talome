"use client";

import { Mermaid, type MermaidProps } from "fumadocs-mermaid/ui";

/**
 * Talome-themed Mermaid wrapper.
 *
 * Uses Mermaid's "dark" base theme with custom CSS overrides that match
 * the Talome OKLCH colour palette (dark background, near-white text,
 * green/amber/red status colours, 10% border opacity).
 */

const TALOME_THEME_CSS = `
  /* Background & text */
  .node rect,
  .node polygon,
  .node circle,
  .node ellipse,
  .node .label-container { fill: #2a2a2a !important; stroke: #444 !important; }
  .node .label, .nodeLabel, .edgeLabel { color: #e8e8e8 !important; fill: #e8e8e8 !important; }
  .edgeLabel rect { fill: #1a1a1a !important; stroke: none !important; }

  /* Edges */
  .edge path, .flowchart-link { stroke: #555 !important; }
  .arrowMarkerPath { fill: #555 !important; stroke: #555 !important; }

  /* Decision diamonds */
  .node.decision rect,
  .node.decision polygon { fill: #1f2937 !important; stroke: #4b5563 !important; }

  /* Success nodes (green tint) */
  .node rect[style*="0d2818"],
  .node polygon[style*="0d2818"] { fill: #0d2818 !important; stroke: #2d6a4f !important; }

  /* Error nodes (red tint) */
  .node rect[style*="2d1117"],
  .node polygon[style*="2d1117"] { fill: #2d1117 !important; stroke: #a94442 !important; }

  /* Subgraph */
  .cluster rect { fill: #1a1a2e !important; stroke: #333 !important; rx: 8px; }
  .cluster span, .cluster .nodeLabel { color: #aaa !important; fill: #aaa !important; }

  /* General cleanup */
  .marker { fill: #666 !important; }
`;

const TALOME_CONFIG = JSON.stringify({
  theme: "dark",
  themeVariables: {
    darkMode: true,
    background: "#1a1a1a",
    primaryColor: "#2a2a2a",
    primaryTextColor: "#e8e8e8",
    primaryBorderColor: "#444",
    secondaryColor: "#1f2937",
    tertiaryColor: "#1a1a2e",
    lineColor: "#555",
    textColor: "#e8e8e8",
    mainBkg: "#2a2a2a",
    nodeBorder: "#444",
    clusterBkg: "#1a1a2e",
    clusterBorder: "#333",
    edgeLabelBackground: "#1a1a1a",
    fontSize: "14px",
  },
  flowchart: {
    curve: "basis",
    padding: 16,
    htmlLabels: true,
  },
});

export function TalomeMermaid(props: MermaidProps) {
  return (
    <div className="flex justify-center my-8">
      <Mermaid
        {...props}
        theme="dark"
        config={props.config ?? TALOME_CONFIG}
        themeCSS={`${TALOME_THEME_CSS}\n${props.themeCSS ?? ""}`}
      />
    </div>
  );
}
