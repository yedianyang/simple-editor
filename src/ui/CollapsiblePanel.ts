/**
 * Reusable collapsible panel controller for FieldCorder DAW.
 * Manages collapse/expand toggling, drag-to-resize handles,
 * and localStorage persistence of panel state.
 */

export interface PanelConfig {
  /** The panel element itself */
  container: HTMLElement;
  /** horizontal = sidebars, vertical = bottom panel */
  direction: 'horizontal' | 'vertical';
  /** Which edge the panel sits on */
  side: 'left' | 'right' | 'bottom';
  /** Default expanded size in px */
  defaultSize: number;
  /** Minimum size in px before auto-collapse */
  minSize: number;
  /** CSS selector within container for the clickable header */
  headerSelector: string;
  /** Prefix for localStorage keys, e.g. 'panel.left' */
  storageKeyPrefix: string;
  /** Whether the panel starts collapsed if no saved state exists */
  collapsedByDefault: boolean;
}

export class CollapsiblePanel {
  private readonly container: HTMLElement;
  private readonly direction: 'horizontal' | 'vertical';
  private readonly side: 'left' | 'right' | 'bottom';
  private readonly defaultSize: number;
  private readonly minSize: number;
  private readonly storageKeyPrefix: string;

  private collapsed: boolean;
  private size: number;
  private handleEl: HTMLDivElement;
  private headerEl: HTMLElement | null;

  /** Called when panel transitions between collapsed and expanded states. */
  onStateChange: ((collapsed: boolean) => void) | null = null;

  /** Bound references for cleanup */
  private readonly onHeaderClick: () => void;
  private readonly onHandleMouseDown: (e: MouseEvent) => void;
  private readonly onHandleDblClick: () => void;

  constructor(config: PanelConfig) {
    this.container = config.container;
    this.direction = config.direction;
    this.side = config.side;
    this.defaultSize = config.defaultSize;
    this.minSize = config.minSize;
    this.storageKeyPrefix = config.storageKeyPrefix;

    // Restore persisted state or use defaults
    this.collapsed = this.loadBoolean('collapsed', config.collapsedByDefault);
    this.size = this.loadNumber('size', config.defaultSize);

    // Create the resize handle
    this.handleEl = this.createResizeHandle();
    this.container.appendChild(this.handleEl);

    // Find the header element for click-to-toggle
    this.headerEl = this.container.querySelector(config.headerSelector);

    // Bind event handlers
    this.onHeaderClick = () => this.toggle();
    this.onHandleMouseDown = (e: MouseEvent) => this.startDrag(e);
    this.onHandleDblClick = () => this.toggle();

    if (this.headerEl) {
      this.headerEl.addEventListener('click', this.onHeaderClick);
    }
    this.handleEl.addEventListener('mousedown', this.onHandleMouseDown);
    this.handleEl.addEventListener('dblclick', this.onHandleDblClick);

    // Apply initial state without transition
    this.container.classList.add('resizing');
    this.applyState();
    // Remove resizing class after a frame so future changes animate
    requestAnimationFrame(() => {
      this.container.classList.remove('resizing');
    });
  }

  /** Toggle between collapsed and expanded states. */
  toggle(): void {
    if (this.collapsed) {
      this.expand();
    } else {
      this.collapse();
    }
  }

  /** Force the panel into expanded state. */
  expand(): void {
    this.collapsed = false;
    this.applyState();
    this.saveState();
    if (this.onStateChange) this.onStateChange(false);
  }

  /** Force the panel into collapsed state. */
  collapse(): void {
    this.collapsed = true;
    this.applyState();
    this.saveState();
    if (this.onStateChange) this.onStateChange(true);
  }

  /** Returns true if the panel is currently collapsed. */
  isCollapsed(): boolean {
    return this.collapsed;
  }

  /** Remove all event listeners and the resize handle element. */
  destroy(): void {
    if (this.headerEl) {
      this.headerEl.removeEventListener('click', this.onHeaderClick);
    }
    this.handleEl.removeEventListener('mousedown', this.onHandleMouseDown);
    this.handleEl.removeEventListener('dblclick', this.onHandleDblClick);
    this.handleEl.remove();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Create and configure the resize handle element. */
  private createResizeHandle(): HTMLDivElement {
    const handle = document.createElement('div');
    handle.classList.add('resize-handle');

    if (this.side === 'left') {
      handle.classList.add('resize-handle-right');
      handle.style.position = 'absolute';
      handle.style.top = '0';
      handle.style.right = '0';
      handle.style.width = '5px';
      handle.style.height = '100%';
      handle.style.cursor = 'col-resize';
    } else if (this.side === 'right') {
      handle.classList.add('resize-handle-left');
      handle.style.position = 'absolute';
      handle.style.top = '0';
      handle.style.left = '0';
      handle.style.width = '5px';
      handle.style.height = '100%';
      handle.style.cursor = 'col-resize';
    } else {
      // bottom
      handle.classList.add('resize-handle-top');
      handle.style.position = 'absolute';
      handle.style.left = '0';
      handle.style.top = '0';
      handle.style.height = '5px';
      handle.style.width = '100%';
      handle.style.cursor = 'row-resize';
    }

    handle.style.zIndex = '10';
    return handle;
  }

  /** Apply the current collapsed/size state to the DOM. */
  private applyState(): void {
    if (this.collapsed) {
      this.container.classList.add('collapsed');
      if (this.direction === 'horizontal') {
        this.container.style.width = '0';
        this.container.style.minWidth = '0';
        this.container.style.overflow = 'hidden';
      }
      // For vertical panels, the collapsed class is enough:
      // CSS keeps only the ~24px header visible.
    } else {
      this.container.classList.remove('collapsed');
      if (this.direction === 'horizontal') {
        this.container.style.width = this.size + 'px';
        this.container.style.minWidth = '';
        this.container.style.overflow = '';
      } else {
        this.container.style.height = this.size + 'px';
      }
    }
  }

  /** Begin a resize drag operation. */
  private startDrag(e: MouseEvent): void {
    // Prevent default to avoid text selection during drag
    e.preventDefault();

    // Do not start drag if panel is collapsed
    if (this.collapsed) {
      return;
    }

    this.container.classList.add('resizing');
    document.body.style.userSelect = 'none';

    const onMouseMove = (moveEvent: MouseEvent) => {
      const rect = this.container.getBoundingClientRect();
      let newSize: number;

      if (this.side === 'left') {
        newSize = moveEvent.clientX - rect.left;
      } else if (this.side === 'right') {
        newSize = rect.right - moveEvent.clientX;
      } else {
        // bottom
        newSize = rect.bottom - moveEvent.clientY;
      }

      // Auto-collapse if dragged below minimum
      if (newSize < this.minSize) {
        this.collapsed = true;
        this.applyState();
        return;
      }

      // Clamp to max 800px
      newSize = Math.min(newSize, 800);

      // If we were collapsed and now above minSize, expand
      if (this.collapsed) {
        this.collapsed = false;
        this.container.classList.remove('collapsed');
        if (this.direction === 'horizontal') {
          this.container.style.minWidth = '';
          this.container.style.overflow = '';
        }
      }

      this.size = newSize;

      if (this.direction === 'horizontal') {
        this.container.style.width = newSize + 'px';
      } else {
        this.container.style.height = newSize + 'px';
      }
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      this.container.classList.remove('resizing');
      document.body.style.userSelect = '';
      this.saveState();
      if (this.onStateChange) this.onStateChange(this.collapsed);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  /** Persist current state to localStorage. */
  private saveState(): void {
    try {
      localStorage.setItem(
        this.storageKeyPrefix + '.collapsed',
        JSON.stringify(this.collapsed)
      );
      localStorage.setItem(
        this.storageKeyPrefix + '.size',
        JSON.stringify(this.size)
      );
    } catch {
      // localStorage may be unavailable (e.g. sandboxed); silently ignore
    }
  }

  /** Load a boolean from localStorage with a fallback. */
  private loadBoolean(key: string, fallback: boolean): boolean {
    try {
      const raw = localStorage.getItem(this.storageKeyPrefix + '.' + key);
      if (raw !== null) {
        return JSON.parse(raw) as boolean;
      }
    } catch {
      // Corrupted or unavailable storage; use fallback
    }
    return fallback;
  }

  /** Load a number from localStorage with a fallback. */
  private loadNumber(key: string, fallback: number): number {
    try {
      const raw = localStorage.getItem(this.storageKeyPrefix + '.' + key);
      if (raw !== null) {
        const parsed = JSON.parse(raw) as number;
        if (typeof parsed === 'number' && Number.isFinite(parsed)) {
          return parsed;
        }
      }
    } catch {
      // Corrupted or unavailable storage; use fallback
    }
    return fallback;
  }
}
