import { ExportMetadata, createDefaultExportMetadata, MIC_PERSPECTIVES, CHANNEL_NAMES } from '../core/types';
import { UCS_TOP_CATEGORIES, getSubCategories, getCatId, generateUCSFilename } from '../core/ucs-data';

/**
 * MetadataManager handles the export metadata dialog.
 * Supports BWF BEXT, iXML, UCS naming, and SFX library metadata fields.
 * Based on Sound Devices / Soundminer / UCS professional standards.
 */
export class MetadataManager {
  private metadata: ExportMetadata;
  private container: HTMLElement;
  private channelCount = 2;
  private onExportConfirm: ((metadata: ExportMetadata, filename: string) => void) | null = null;

  constructor() {
    this.metadata = createDefaultExportMetadata();
    this.container = document.getElementById('metadataModal')!;
    this.setupEventListeners();
    this.populateUCSCategories();
    this.populateMicPerspectives();
  }

  private setupEventListeners(): void {
    // UCS category cascade
    const catSelect = document.getElementById('ucsCategory') as HTMLSelectElement;
    catSelect?.addEventListener('change', () => {
      this.metadata.ucsCategory = catSelect.value;
      this.updateSubCategories();
      this.updateCatId();
      this.updateFilenamePreview();
    });

    const subCatSelect = document.getElementById('ucsSubCategory') as HTMLSelectElement;
    subCatSelect?.addEventListener('change', () => {
      this.metadata.ucsSubCategory = subCatSelect.value;
      this.updateCatId();
      this.updateFilenamePreview();
    });

    // UCS filename fields
    ['ucsFxName', 'ucsCreatorId', 'ucsSourceId'].forEach(id => {
      const el = document.getElementById(id) as HTMLInputElement;
      el?.addEventListener('input', () => {
        (this.metadata as any)[id] = el.value;
        this.updateFilenamePreview();
      });
    });

    // All other text inputs
    const textFields = [
      'bpiDescription', 'originator', 'originatorRef',
      'project', 'scene', 'take', 'tape', 'note',
      'recordist', 'microphone', 'location', 'library', 'keywords'
    ];
    textFields.forEach(id => {
      const el = document.getElementById(id) as HTMLInputElement;
      el?.addEventListener('input', () => {
        (this.metadata as any)[id] = el.value;
      });
    });

    // Mic perspective
    const micPerspEl = document.getElementById('micPerspective') as HTMLSelectElement;
    micPerspEl?.addEventListener('change', () => {
      this.metadata.micPerspective = micPerspEl.value;
    });

    // Checkboxes
    const circledEl = document.getElementById('circled') as HTMLInputElement;
    circledEl?.addEventListener('change', () => {
      this.metadata.circled = circledEl.checked;
    });
    const wildTrackEl = document.getElementById('wildTrack') as HTMLInputElement;
    wildTrackEl?.addEventListener('change', () => {
      this.metadata.wildTrack = wildTrackEl.checked;
    });

    // Modal buttons
    document.getElementById('metadataCancelBtn')?.addEventListener('click', () => this.hide());
    document.getElementById('metadataExportBtn')?.addEventListener('click', () => this.confirmExport());

    // Tab switching
    document.querySelectorAll('.metadata-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const tabName = (tab as HTMLElement).dataset.tab!;
        this.switchTab(tabName);
      });
    });
  }

  private populateUCSCategories(): void {
    const select = document.getElementById('ucsCategory') as HTMLSelectElement;
    if (!select) return;

    select.innerHTML = '<option value="">-- Select Category --</option>';
    UCS_TOP_CATEGORIES.forEach(cat => {
      const opt = document.createElement('option');
      opt.value = cat;
      opt.textContent = cat;
      select.appendChild(opt);
    });
  }

  private updateSubCategories(): void {
    const select = document.getElementById('ucsSubCategory') as HTMLSelectElement;
    if (!select) return;

    select.innerHTML = '<option value="">-- Select SubCategory --</option>';
    if (!this.metadata.ucsCategory) return;

    const subs = getSubCategories(this.metadata.ucsCategory);
    subs.forEach(sub => {
      const opt = document.createElement('option');
      opt.value = sub;
      opt.textContent = sub;
      select.appendChild(opt);
    });
  }

  private updateCatId(): void {
    const catIdEl = document.getElementById('ucsCatId') as HTMLInputElement;
    if (!catIdEl) return;

    if (this.metadata.ucsCategory && this.metadata.ucsSubCategory) {
      const catId = getCatId(this.metadata.ucsCategory, this.metadata.ucsSubCategory);
      this.metadata.ucsCatId = catId || '';
    } else {
      this.metadata.ucsCatId = '';
    }
    catIdEl.value = this.metadata.ucsCatId;
  }

  private updateFilenamePreview(): void {
    const previewEl = document.getElementById('ucsFilenamePreview');
    if (!previewEl) return;

    if (this.metadata.ucsCatId && this.metadata.ucsFxName) {
      const filename = generateUCSFilename(
        this.metadata.ucsCatId,
        this.metadata.ucsFxName,
        this.metadata.ucsCreatorId,
        this.metadata.ucsSourceId
      );
      previewEl.textContent = filename;
      previewEl.classList.add('has-value');
    } else {
      previewEl.textContent = '(set Category + FX Name to preview)';
      previewEl.classList.remove('has-value');
    }
  }

  private populateMicPerspectives(): void {
    const select = document.getElementById('micPerspective') as HTMLSelectElement;
    if (!select) return;

    select.innerHTML = '<option value="">-- None --</option>';
    MIC_PERSPECTIVES.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p;
      opt.textContent = p;
      select.appendChild(opt);
    });
  }

  private switchTab(tabName: string): void {
    document.querySelectorAll('.metadata-tab').forEach(t => {
      t.classList.toggle('active', (t as HTMLElement).dataset.tab === tabName);
    });
    document.querySelectorAll('.metadata-tab-content').forEach(c => {
      (c as HTMLElement).style.display = (c as HTMLElement).dataset.tab === tabName ? 'block' : 'none';
    });
  }

  private buildTrackNameInputs(): void {
    const container = document.getElementById('trackNamesContainer');
    if (!container) return;

    container.innerHTML = '';
    const names = CHANNEL_NAMES[this.channelCount] ||
      Array.from({ length: this.channelCount }, (_, i) => `Ch ${i + 1}`);

    this.metadata.trackNames = new Array(this.channelCount).fill('');

    for (let i = 0; i < this.channelCount; i++) {
      const row = document.createElement('div');
      row.className = 'metadata-field-row';

      const label = document.createElement('label');
      label.textContent = `Track ${i + 1} (${names[i]})`;

      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = names[i];
      input.value = this.metadata.trackNames[i] || '';
      const idx = i;
      input.addEventListener('input', () => {
        this.metadata.trackNames[idx] = input.value;
      });

      row.appendChild(label);
      row.appendChild(input);
      container.appendChild(row);
    }
  }

  show(channelCount: number, callback: (metadata: ExportMetadata, filename: string) => void): void {
    this.channelCount = channelCount;
    this.onExportConfirm = callback;
    this.buildTrackNameInputs();
    this.syncUIFromMetadata();
    this.switchTab('ucs');
    this.container.classList.add('visible');
  }

  hide(): void {
    this.container.classList.remove('visible');
  }

  private syncUIFromMetadata(): void {
    const fields = [
      'bpiDescription', 'originator', 'originatorRef',
      'project', 'scene', 'take', 'tape', 'note',
      'ucsFxName', 'ucsCreatorId', 'ucsSourceId',
      'recordist', 'microphone', 'location', 'library', 'keywords'
    ];
    fields.forEach(id => {
      const el = document.getElementById(id) as HTMLInputElement;
      if (el) el.value = (this.metadata as any)[id] || '';
    });

    // Selects
    const catSelect = document.getElementById('ucsCategory') as HTMLSelectElement;
    if (catSelect) catSelect.value = this.metadata.ucsCategory;
    this.updateSubCategories();
    const subCatSelect = document.getElementById('ucsSubCategory') as HTMLSelectElement;
    if (subCatSelect) subCatSelect.value = this.metadata.ucsSubCategory;
    this.updateCatId();
    this.updateFilenamePreview();

    const micPerspEl = document.getElementById('micPerspective') as HTMLSelectElement;
    if (micPerspEl) micPerspEl.value = this.metadata.micPerspective;

    const circledEl = document.getElementById('circled') as HTMLInputElement;
    if (circledEl) circledEl.checked = this.metadata.circled;
    const wildTrackEl = document.getElementById('wildTrack') as HTMLInputElement;
    if (wildTrackEl) wildTrackEl.checked = this.metadata.wildTrack;
  }

  private confirmExport(): void {
    // Generate the UCS filename if applicable
    let filename = '';
    if (this.metadata.ucsCatId && this.metadata.ucsFxName) {
      filename = generateUCSFilename(
        this.metadata.ucsCatId,
        this.metadata.ucsFxName,
        this.metadata.ucsCreatorId,
        this.metadata.ucsSourceId
      );
    }

    this.hide();
    if (this.onExportConfirm) {
      this.onExportConfirm(this.metadata, filename);
    }
  }

  getMetadata(): ExportMetadata {
    return { ...this.metadata };
  }

  setMetadata(partial: Partial<ExportMetadata>): void {
    Object.assign(this.metadata, partial);
  }
}
