/**
 * Tab switcher for the bottom analysis panel.
 * Manages "Spectrum" and "Sonogram" tabs, persisting the active tab to localStorage.
 */
export class AnalysisPanel {
  /** Called when a tab is clicked while the panel is collapsed. */
  onRequestExpand: (() => void) | null = null;
  /** Called after the active tab changes. */
  onTabChange: ((tabId: string) => void) | null = null;

  private container: HTMLElement;
  private tabButtons: HTMLButtonElement[];
  private tabPanes: HTMLElement[];
  private activeTab: string;
  private boundClickHandler: (e: Event) => void;

  constructor(container: HTMLElement) {
    this.container = container;
    this.tabButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.analysis-tab')
    );
    this.tabPanes = Array.from(
      container.querySelectorAll<HTMLElement>('.analysis-tab-pane')
    );

    this.boundClickHandler = (e: Event) => this.handleTabClick(e);
    for (const btn of this.tabButtons) {
      btn.addEventListener('click', this.boundClickHandler);
    }

    const saved = localStorage.getItem('analysis.activeTab');
    this.activeTab = saved ?? 'spectrum';
    this.setActiveTab(this.activeTab);
  }

  /**
   * Switch to the given tab, updating button and pane visibility.
   * Persists the choice to localStorage.
   */
  setActiveTab(tabId: string): void {
    this.activeTab = tabId;

    for (const btn of this.tabButtons) {
      if (btn.dataset.tab === tabId) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    }

    for (const pane of this.tabPanes) {
      if (pane.dataset.tab === tabId) {
        pane.classList.remove('hidden');
      } else {
        pane.classList.add('hidden');
      }
    }

    localStorage.setItem('analysis.activeTab', tabId);
    if (this.onTabChange) this.onTabChange(tabId);
  }

  /** Returns the currently active tab identifier. */
  getActiveTab(): string {
    return this.activeTab;
  }

  /** Remove event listeners. */
  destroy(): void {
    for (const btn of this.tabButtons) {
      btn.removeEventListener('click', this.boundClickHandler);
    }
  }

  private handleTabClick(e: Event): void {
    const target = e.currentTarget as HTMLButtonElement;
    const tabId = target.dataset.tab;
    if (!tabId) return;

    if (this.container.classList.contains('collapsed') && this.onRequestExpand) {
      this.onRequestExpand();
    }

    this.setActiveTab(tabId);
  }
}
