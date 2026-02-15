import { FileQueueItem } from '../core/types';

/**
 * File queue manager for multi-file workflow.
 */
export class FileQueue {
  files: FileQueueItem[] = [];
  activeFileId: number | null = null;

  addFile(file: File | { name: string; path: string }): number {
    const id = Date.now() + Math.random();
    this.files.push({ id, file, cuePoints: [] });
    return id;
  }

  addFiles(fileList: Array<File | { name: string; path: string }>): number[] {
    const ids: number[] = [];
    for (const file of fileList) {
      ids.push(this.addFile(file));
    }
    return ids;
  }

  removeFile(id: number): void {
    const index = this.files.findIndex(f => f.id === id);
    if (index !== -1) {
      this.files.splice(index, 1);
      if (this.activeFileId === id) {
        this.activeFileId = null;
      }
    }
  }

  getFile(id: number): (File | { name: string; path: string }) | null {
    const item = this.files.find(f => f.id === id);
    return item ? item.file : null;
  }

  setActive(id: number): void {
    this.activeFileId = id;
  }

  getActive(): number | null {
    return this.activeFileId;
  }

  getAll(): FileQueueItem[] {
    return this.files;
  }

  setCuePoints(id: number, cuePoints: Array<{ sample: number; name: string }>): void {
    const item = this.files.find(f => f.id === id);
    if (item) {
      item.cuePoints = cuePoints;
    }
  }

  getCuePoints(id: number): Array<{ sample: number; name: string }> {
    const item = this.files.find(f => f.id === id);
    return item ? item.cuePoints : [];
  }
}
