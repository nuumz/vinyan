/**
 * Screen — full-screen rendering engine with frame-coalesced painting.
 *
 * Uses alternate screen buffer. Renders at 30fps max, skipping frames
 * when state hasn't changed (dirty flag).
 */

import { enterAltScreen, leaveAltScreen, paintFrame } from './renderer.ts';
import { markClean, updateTermSize } from './state.ts';
import type { TUIState } from './types.ts';

export type ViewRenderer = (state: TUIState) => string;

export class Screen {
  private timer: ReturnType<typeof setInterval> | null = null;
  private state: TUIState;
  private viewRenderer: ViewRenderer;
  private resizeHandler: (() => void) | null = null;

  constructor(state: TUIState, viewRenderer: ViewRenderer) {
    this.state = state;
    this.viewRenderer = viewRenderer;
  }

  start(): void {
    enterAltScreen();

    // Handle terminal resize
    this.resizeHandler = () => {
      updateTermSize(this.state);
    };
    process.stdout.on('resize', this.resizeHandler);

    // Render loop at ~30fps (33ms interval)
    this.timer = setInterval(() => this.tick(), 33);

    // Force initial render
    this.state.dirty = true;
    this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.resizeHandler) {
      process.stdout.removeListener('resize', this.resizeHandler);
      this.resizeHandler = null;
    }
    leaveAltScreen();
  }

  /** Force an immediate re-render. */
  forceRender(): void {
    this.state.dirty = true;
    this.tick();
  }

  private tick(): void {
    if (!this.state.dirty) return;

    updateTermSize(this.state);
    const frame = this.viewRenderer(this.state);
    paintFrame(frame);
    markClean(this.state);
  }
}
