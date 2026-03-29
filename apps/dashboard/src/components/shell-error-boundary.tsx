"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Optional fallback UI. If not provided, renders nothing on error. */
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * Lightweight error boundary for non-critical shell components.
 * When a child (e.g. CommandPalette, overlays) throws, it catches the error
 * silently instead of crashing the entire dashboard — keeping navigation,
 * sidebar, and the terminal page accessible.
 */
export class ShellErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ShellErrorBoundary] Caught error in shell component:", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? null;
    }
    return this.props.children;
  }
}
