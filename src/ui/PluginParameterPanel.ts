import { PluginHost } from '../plugins/PluginHost';
import { PluginInstance, PluginParameter } from '../core/types';
import { EQ7Panel } from '../plugins/EQ7Panel';

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
  private panelDragging = false;
  private dragOffsetX = 0;
  private dragOffsetY = 0;
  private eq7Panel: EQ7Panel | null = null;

  constructor() {
    this.container = document.createElement('div');
    this.container.className = 'plugin-param-panel';
    this.container.style.display = 'none';
    document.body.appendChild(this.container);

    // Close when clicking outside (skip if panel was just opened this frame)
    document.addEventListener('mousedown', (e) => {
      if (this.openedThisFrame) return;
      const target = e.target as Node;
      // Check if EQ7 panel is open and click is inside it
      if (this.eq7Panel?.isVisible() && this.eq7Panel.containsElement(target)) return;
      if (this.eq7Panel?.isVisible()) {
        this.hide();
        return;
      }
      if (this.container.style.display !== 'none' &&
          !this.container.contains(target)) {
        this.hide();
      }
    });

    // Drag support for repositioning the panel
    document.addEventListener('mousemove', (e) => {
      if (!this.panelDragging) return;
      let left = e.clientX - this.dragOffsetX;
      let top = e.clientY - this.dragOffsetY;
      left = Math.max(0, Math.min(window.innerWidth - 320, left));
      top = Math.max(0, Math.min(window.innerHeight - 40, top));
      this.container.style.left = left + 'px';
      this.container.style.top = top + 'px';
    });
    document.addEventListener('mouseup', () => { this.panelDragging = false; });
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

    // Delegate to EQ7 graphical panel
    if (instance.pluginInfo.id === 'builtin:eq7') {
      if (!this.eq7Panel) this.eq7Panel = new EQ7Panel();
      this.eq7Panel.setPluginHost(this.pluginHost);
      this.container.style.display = 'none';

      let left: number, top: number;
      if (anchorEl) {
        const rect = anchorEl.getBoundingClientRect();
        left = rect.right + 8;
        top = rect.top;
      } else if (position) {
        left = position.x + 8;
        top = position.y;
      } else {
        left = 100;
        top = 100;
      }

      this.eq7Panel.show(instance, instanceId, left, top);
      this.openedThisFrame = true;
      requestAnimationFrame(() => { this.openedThisFrame = false; });
      return;
    }

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
    this.eq7Panel?.hide();
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

    // Drag header to reposition panel
    const header = this.container.querySelector('.plugin-param-header') as HTMLElement | null;
    if (header) {
      header.addEventListener('mousedown', (e) => {
        if ((e.target as HTMLElement).closest('.plugin-param-close')) return;
        this.panelDragging = true;
        const rect = this.container.getBoundingClientRect();
        this.dragOffsetX = e.clientX - rect.left;
        this.dragOffsetY = e.clientY - rect.top;
        e.preventDefault();
      });
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
