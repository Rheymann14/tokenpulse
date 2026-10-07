import { LogicalSize, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import type { Monitor, Window } from "@tauri-apps/api/window";

export type WindowView = { position: PhysicalPosition; size: PhysicalSize; resizable: boolean };

export async function captureView(window: Window): Promise<WindowView> {
  const [position, size, resizable] = await Promise.all([window.outerPosition(), window.innerSize(), window.isResizable()]);
  return { position, size, resizable };
}

export async function dockCompact(window: Window, monitor: Monitor, height: number) {
  await window.setMinSize(new LogicalSize(240, 80));
  await window.setSize(new LogicalSize(260, height));
  await window.setResizable(false);
  await anchorCompact(window, monitor);
}

export async function anchorCompact(window: Window, monitor: Monitor) {
  const [size, position] = await Promise.all([window.outerSize(), window.outerPosition()]);
  const area = monitor.workArea;
  const margin = Math.round(12 * monitor.scaleFactor);
  const x = Math.max(area.position.x + margin, area.position.x + area.size.width - size.width - margin);
  const y = Math.max(area.position.y + margin, area.position.y + area.size.height - size.height - margin);
  if (position.x !== x || position.y !== y) await window.setPosition(new PhysicalPosition(x, y));
}

export async function restoreView(window: Window, view: WindowView) {
  await window.setMinSize(new LogicalSize(280, 330));
  await window.setSize(view.size);
  await window.setPosition(view.position);
  await window.setResizable(view.resizable);
}

export async function fitDetails(window: Window, height: number) {
  const minimum = Math.max(330, height);
  await window.setMinSize(new LogicalSize(280, minimum));
  const [size, scale] = await Promise.all([window.innerSize(), window.scaleFactor()]);
  const logical = size.toLogical(scale);
  if (logical.height < minimum) await window.setSize(new LogicalSize(Math.max(280, logical.width), minimum));
}
