"use client"

import { Component } from "react"

/**
 * Catches failures while creating or rendering the WebGL scene (e.g. a GPU
 * blocklist or lost context) and shows the 2D fallback instead of a broken page.
 */
export class SceneErrorBoundary extends Component<
  { fallback: React.ReactNode; children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: unknown) {
    console.warn(
      "3D office failed to render; showing the 2D map instead.",
      error,
    )
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}
