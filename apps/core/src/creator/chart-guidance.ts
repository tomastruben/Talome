import { TalomeAppSpecSchema } from "../app-specs/schema.js";

/** Executable schema examples describe source shapes; their observations are explicitly synthetic. */
export function nativeChartGuide() {
  const examples = [
    {
      intent: "Compare categories using a bar chart and inspect exact values",
      patternId: "analytical-comparison", appId: "sensor-comparison-example", name: "Compare sensors",
      title: "Temperature by sensor", description: "Compare observed and reference temperatures on the same Celsius scale.",
      variant: "bar", unit: "°C", xLabel: "Sensor", valueLabel: "Temperature", xPath: "sensor",
      series: [{ id: "observed", label: "Observed", valuePath: "observed" }, { id: "reference", label: "Reference", valuePath: "reference" }],
      exampleResponse: { rows: [{ sensor: "Freezer", observed: -18, reference: -20 }, { sensor: "Cool room", observed: 0, reference: 2 }, { sensor: "Outdoor", observed: null, reference: 8 }] },
    },
    {
      intent: "Show a multi-series chart of response time and investigate slower observations",
      patternId: "metric-monitor", appId: "latency-trend-example", name: "Review response time",
      title: "Response time over observations", description: "Compare median and 95th percentile latency from the same sample window.",
      variant: "line", unit: "ms", xLabel: "Observation time", valueLabel: "Response time", xPath: "time",
      series: [{ id: "median", label: "Median", valuePath: "medianMs" }, { id: "p95", label: "95th percentile", valuePath: "p95Ms" }],
      exampleResponse: { rows: [{ time: "10:00", medianMs: 120, p95Ms: 260 }, { time: "10:05", medianMs: null, p95Ms: null }, { time: "10:10", medianMs: 95, p95Ms: 210 }] },
    },
  ];
  return {
    version: "talome-charts:1",
    renderer: "Recharts through the shipped shadcn ChartContainer; no extra dependency or executable chart configuration is needed.",
    rules: [
      "Use time-series variant bar for grouped category comparisons; line for ordered trends; area for magnitude over ordered observations. Stacked, pie, scatter, heatmap and dual-axis charts are not declared native variants.",
      "xPath selects source-provided readable category/time labels. Rows retain source order. Prepare correct sorting and aggregation in the backend; the renderer does not invent buckets, totals, dates or observations.",
      "One to six uniquely identified series share one numeric unit and scale. xLabel and valueLabel name the axes. unit is a display suffix such as ms or °C and never converts values.",
      "Chart valueFormat number is unitless unless unit is supplied; currency requires the intended three-letter currency code; bytes accepts byte counts. Chart percent uses fractions consistently: 0.01 is 1%, 1 is 100%, and 1.2 is 120%. Do not mix fractions and percentage points.",
      "Missing, blank, boolean or invalid numeric observations are not zero. Preserve nulls as gaps or missing bars and show missing-data text. Valid zero and negative values must remain visible. Supply finite numbers; numeric strings are accepted for compatibility.",
      "Use one clear comparison chart and a table for exact values before adding unrelated metrics. A multi-surface app should group related questions and declare meaningful actions; more blocks alone do not establish a useful complex UI.",
      "These exampleResponse values are synthetic schema demonstrations only. Implement the declared app API and replace example values with actual domain observations. Label intentional demos. A valid spec is not evidence of a live backend.",
      "Validate actual chart marks, series labels, units, exact values, missing data and error/empty recovery in dark mode at phone 390px, compact desktop 480px, tablet 768px and desktop 1440px.",
    ],
    examples: examples.map((example) => ({
      intent: example.intent, patternId: example.patternId, exampleResponse: example.exampleResponse,
      dataProvenance: "Synthetic response shape for development; not measured data.",
      spec: TalomeAppSpecSchema.parse({
        schemaVersion: 1, revision: 1, appId: example.appId, name: example.name, description: example.description,
        assistant: { context: "Explain the app's actual observations, units and missing data. Never substitute example responses for measurements.", suggestions: [{ label: "Explain this comparison", prompt: "Explain the observed differences and missing values using the app's real source." }], exposedActions: ["explain-observations"] },
        dataSources: [{ id: "observations", kind: "app-api", appId: example.appId, path: "/api/observations" }],
        actions: [{ id: "explain-observations", kind: "assistant", label: "Explain observations", description: "Ask for an explanation grounded in the app's source and its limitations.", prompt: "Inspect the app's observations. Explain the comparison, units and missing data; distinguish evidence from uncertainty." }],
        surfaces: [{ id: "comparison", title: example.name, layout: "dashboard", primaryActionId: "explain-observations", blocks: [
          { id: "comparison-chart", component: "time-series", title: example.title, description: example.description, dataSource: "observations", rowsPath: "rows", xPath: example.xPath, series: example.series, variant: example.variant, valueFormat: "number", unit: example.unit, xLabel: example.xLabel, valueLabel: example.valueLabel, span: 4 },
          { id: "exact-values", component: "table", title: `Exact values (${example.unit})`, dataSource: "observations", rowsPath: "rows", span: 4, columns: [
            { id: "category", label: example.xLabel, path: example.xPath },
            ...example.series.map((series) => ({ id: series.id, label: `${series.label} (${example.unit})`, path: series.valuePath, format: "number" })),
          ] },
        ] }],
      }),
    })),
  };
}
