export function workspaceZoom() {
  return document.body.currentCSSZoom || Number.parseFloat(getComputedStyle(document.body).zoom) || 1
}

// Browser rectangles use viewport pixels, while positioned styles use the workspace's layout pixels.
export function workspaceRect(element: Element, zoom = workspaceZoom()) {
  const { left, top, right, bottom, width, height } = element.getBoundingClientRect()
  return { left: left / zoom, top: top / zoom, right: right / zoom, bottom: bottom / zoom,
    width: width / zoom, height: height / zoom }
}

export function workspaceViewport(visual?: VisualViewport | null) {
  const zoom = workspaceZoom()
  return { left: (visual?.offsetLeft ?? 0) / zoom, top: (visual?.offsetTop ?? 0) / zoom,
    width: (visual?.width ?? window.innerWidth) / zoom, height: (visual?.height ?? window.innerHeight) / zoom }
}
