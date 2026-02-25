import { PluginHost } from '../plugins/PluginHost';
import { PluginInstance, PluginParameter } from '../core/types';

/**
 * Floating panel that displays plugin parameters as sliders.
 * Shown when clicking a plugin slot in the mixer.
 */
export class PluginParameterPanel {
  private container: HTMLElement;
  private currentInstanceId: string | null = null;
  private pluginHost: PluginHost | null = null;
  /** Guards against the click-outside listener closing the panel in the same event that opened it. */
  private openedThisFrame = false;

  constructor() {
    this.container = document.createElement('div');
    this.container.className = 'plugin-param-panel';
    this.container.style.display = 'none';
    document.body.appendChild(this.container);

    // Close when clicking outside (skip if panel was just opened this frame)
    document.addEventListener('mousedown', (e) => {
      if (this.openedThisFrame) return;
      if (this.container.style.display !== 'none' &&
          !this.container.contains(e.target as Node)) {
        this.hide();
      }
    });
  }

  setPluginHost(pluginHost: PluginHost): void {
    this.pluginHost = pluginHost;
  }

  show(instanceId: string, anchorEl?: HTMLElement, position?: { x: number; y: number }): void {
    if (!this.pluginHost) return;

    // Toggle: clicking the same plugin again closes the panel
    if (this.currentInstanceId === instanceId && this.container.style.display !== 'none') {
      this.hide();
      return;
    }

    const instance = this.pluginHost.getInstance(instanceId);
    if (!instance) return;

    this.currentInstanceId = instanceId;
    this.renderParameters(instance);

    const panelWidth = 320;
    const panelHeight = this.container.offsetHeight || 200;

    if (anchorEl) {
      // Position near the anchor element
      const rect = anchorEl.getBoundingClientRect();
      let left = rect.right + 8;
      let top = rect.top;

      if (left + panelWidth > window.innerWidth) {
        left = rect.left - panelWidth - 8;
      }
      if (top + panelHeight > window.innerHeight) {
        top = window.innerHeight - panelHeight - 8;
      }
      if (top < 0) top = 8;

      this.container.style.left = `${left}px`;
      this.container.style.top = `${top}px`;
    } else if (position) {
      // Position near click coordinates (e.g. from canvas click)
      let left = position.x + 8;
      let top = position.y;

      if (left + panelWidth > window.innerWidth) {
        left = position.x - panelWidth - 8;
      }
      if (top + panelHeight > window.innerHeight) {
        top = window.innerHeight - panelHeight - 8;
      }
      if (top < 0) top = 8;
      if (left < 0) left = 8;

      this.container.style.left = `${left}px`;
      this.container.style.top = `${top}px`;
    }

    this.container.style.pointerEvents = 'auto';
    this.container.style.display = 'block';

    // Prevent the click-outside listener from immediately closing us
    this.openedThisFrame = true;
    requestAnimationFrame(() => { this.openedThisFrame = false; });
  }

  hide(): void {
    this.container.style.display = 'none';
    this.container.style.pointerEvents = 'none';
    this.currentInstanceId = null;
  }

  isVisible(): boolean {
    return this.container.style.display !== 'none';
  }

  getCurrentInstanceId(): string | null {
    return this.currentInstanceId;
  }

  private renderParameters(instance: PluginInstance): void {
    const params = instance.parameters;
    const name = instance.pluginInfo.name;

    let html = `<div class="plugin-param-header">
      <span class="plugin-param-title">${name}</span>
      <button class="plugin-param-close">&times;</button>
    </div>`;

    if (params.length === 0) {
      html += '<div class="plugin-param-empty">No parameters</div>';
    } else {
      html += '<div class="plugin-param-body">';
      for (const param of params) {
        const step = this.computeStep(param);
        html += `
          <div class="plugin-param-row" data-param-id="${param.id}">
            <label class="plugin-param-label">${param.name}</label>
            <input type="range" class="plugin-param-slider"
                   min="${param.min}" max="${param.max}" step="${step}"
                   value="${param.value}" data-param-id="${param.id}">
            <span class="plugin-param-value">${this.formatValue(param)}</span>
          </div>`;
      }
      html += '</div>';
    }

    this.container.innerHTML = html;

    // Close button
    const closeBtn = this.container.querySelector('.plugin-param-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.hide());
    }

    // Slider input events
    this.container.querySelectorAll('.plugin-param-slider').forEach(el => {
      el.addEventListener('input', (e) => {
        const target = e.target as HTMLInputElement;
        const paramId = parseInt(target.dataset.paramId!);
        const value = parseFloat(target.value);

        if (this.pluginHost && this.currentInstanceId) {
          this.pluginHost.setParameter(this.currentInstanceId, paramId, value);
        }

        // Update the displayed value
        const row = target.closest('.plugin-param-row');
        const valueSpan = row?.querySelector('.plugin-param-value');
        if (valueSpan && instance) {
          const param = instance.parameters.find(p => p.id === paramId);
          if (param) {
            param.value = value;
            valueSpan.textContent = this.formatValue(param);
          }
        }
      });
    });
  }

  private computeStep(param: PluginParameter): number {
    const range = param.max - param.min;
    if (range <= 1) return 0.001;
    if (range <= 100) return 0.1;
    return 1;
  }

  private formatValue(param: PluginParameter): string {
    const v = param.value;
    const unit = param.unit || '';
    if (Math.abs(v) < 10) {
      return `${v.toFixed(2)}${unit ? ' ' + unit : ''}`;
    }
    return `${v.toFixed(1)}${unit ? ' ' + unit : ''}`;
  }
}
