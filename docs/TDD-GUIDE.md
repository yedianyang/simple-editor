# FieldCorder TDD Quick Start Guide

## 🎯 Philosophy

> "Write the test you wish you had, then make it pass."

TDD is not about testing — it's about **design**. Tests force you to think about the API before implementation.

---

## 🔄 The Red-Green-Refactor Loop

### Example: Implementing CollapsiblePanel

#### 🔴 RED - Write Failing Test

```typescript
// tests/unit/CollapsiblePanel.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CollapsiblePanel } from '../../src/ui/CollapsiblePanel';

describe('CollapsiblePanel', () => {
  let container: HTMLElement;
  let panel: CollapsiblePanel;

  beforeEach(() => {
    // Setup DOM
    container = document.createElement('div');
    container.id = 'testPanel';
    container.style.width = '300px';
    document.body.appendChild(container);

    panel = new CollapsiblePanel({
      element: container,
      direction: 'horizontal',
      defaultSize: 300,
      collapsedByDefault: false,
    });
  });

  afterEach(() => {
    document.body.removeChild(container);
  });

  it('should initialize with default size', () => {
    expect(container.style.width).toBe('300px');
    expect(panel.isCollapsed()).toBe(false);
  });

  it('should collapse when toggle() is called', () => {
    panel.toggle();
    expect(panel.isCollapsed()).toBe(true);
    expect(container.style.width).toBe('0px');
  });

  it('should expand when toggle() is called twice', () => {
    panel.toggle(); // collapse
    panel.toggle(); // expand
    expect(panel.isCollapsed()).toBe(false);
    expect(container.style.width).toBe('300px');
  });

  it('should save state to localStorage', () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    
    panel.toggle();
    
    expect(setItemSpy).toHaveBeenCalledWith(
      'panel-testPanel-collapsed',
      'true'
    );
  });
});
```

**Run test:** `npm test CollapsiblePanel`  
**Result:** ❌ All tests fail (CollapsiblePanel doesn't exist yet)

---

#### 🟢 GREEN - Make It Pass

```typescript
// src/ui/CollapsiblePanel.ts
export interface CollapsiblePanelOptions {
  element: HTMLElement;
  direction: 'horizontal' | 'vertical';
  defaultSize: number;
  collapsedByDefault: boolean;
}

export class CollapsiblePanel {
  private element: HTMLElement;
  private direction: 'horizontal' | 'vertical';
  private defaultSize: number;
  private collapsed: boolean;

  constructor(options: CollapsiblePanelOptions) {
    this.element = options.element;
    this.direction = options.direction;
    this.defaultSize = options.defaultSize;
    this.collapsed = options.collapsedByDefault;

    // Load saved state
    const savedState = localStorage.getItem(
      `panel-${this.element.id}-collapsed`
    );
    if (savedState !== null) {
      this.collapsed = savedState === 'true';
    }

    this.render();
  }

  toggle(): void {
    this.collapsed = !this.collapsed;
    this.render();
    this.saveState();
  }

  isCollapsed(): boolean {
    return this.collapsed;
  }

  private render(): void {
    if (this.direction === 'horizontal') {
      this.element.style.width = this.collapsed ? '0px' : `${this.defaultSize}px`;
    } else {
      this.element.style.height = this.collapsed ? '0px' : `${this.defaultSize}px`;
    }
  }

  private saveState(): void {
    localStorage.setItem(
      `panel-${this.element.id}-collapsed`,
      String(this.collapsed)
    );
  }
}
```

**Run test:** `npm test CollapsiblePanel`  
**Result:** ✅ All tests pass

---

#### 🔵 REFACTOR - Improve

```typescript
// Improvements:
// 1. Add transition CSS class
// 2. Extract localStorage key to constant
// 3. Add destroy() method
// 4. Type-safe localStorage wrapper

export class CollapsiblePanel {
  private static readonly STORAGE_PREFIX = 'panel';
  
  // ... (same properties)

  constructor(options: CollapsiblePanelOptions) {
    // ... (same init)
    
    // Add CSS transition
    this.element.style.transition = 'width 0.2s ease, height 0.2s ease';
  }

  toggle(): void {
    this.collapsed = !this.collapsed;
    this.render();
    this.saveState();
    
    // Emit event for other components
    this.element.dispatchEvent(new CustomEvent('panelToggle', {
      detail: { collapsed: this.collapsed }
    }));
  }

  destroy(): void {
    this.element.style.transition = '';
    // Clean up if needed
  }

  private getStorageKey(): string {
    return `${CollapsiblePanel.STORAGE_PREFIX}-${this.element.id}-collapsed`;
  }

  private loadState(): boolean {
    const saved = localStorage.getItem(this.getStorageKey());
    return saved === 'true';
  }

  private saveState(): void {
    localStorage.setItem(this.getStorageKey(), String(this.collapsed));
  }
}
```

**Run test:** `npm test CollapsiblePanel`  
**Result:** ✅ Still passing (refactor successful)

---

## 🐛 Bug Fix Example

### Problem: Export Interface Freeze (P0)

#### 🔴 RED - Reproduce Bug

```typescript
// tests/unit/ExportDialog.test.ts
it('should not throw when opening export dialog', () => {
  // This test will fail until bug is fixed
  expect(() => {
    const modal = document.getElementById('metadataModal');
    if (!modal) throw new Error('Modal element not found');
    
    // Simulate clicking export button
    const exportBtn = document.getElementById('exportBtn');
    exportBtn?.click();
  }).not.toThrow();
});
```

**Result:** ❌ Test fails (TypeError: Cannot read properties of null)

#### 🟢 GREEN - Fix Bug

Add missing modal element to `index.html`:

```html
<div id="metadataModal" class="modal hidden">
  <!-- modal content -->
</div>
```

Update `ExportManager.ts` to check for null:

```typescript
openDialog() {
  const modal = document.getElementById('metadataModal');
  if (!modal) {
    console.error('Export modal not found');
    return;
  }
  modal.classList.remove('hidden');
}
```

**Result:** ✅ Test passes

---

## 📋 Test Checklist

Before committing any code, verify:

- [ ] All tests pass (`npm test`)
- [ ] New features have tests
- [ ] Bug fixes have regression tests
- [ ] Coverage >80% for new code (`npm run test:coverage`)
- [ ] No manual "TODO: add test later" comments

---

## 🎓 TDD Anti-Patterns to Avoid

### ❌ Testing Implementation Details

```typescript
// BAD: Test internal state
it('should set _collapsed to true', () => {
  panel._collapsed = true; // Don't test private internals!
});

// GOOD: Test observable behavior
it('should hide panel when collapsed', () => {
  panel.toggle();
  expect(panel.isCollapsed()).toBe(true);
  expect(container.offsetWidth).toBe(0);
});
```

### ❌ Over-Mocking

```typescript
// BAD: Mock everything
const mockEngine = {
  init: vi.fn(),
  play: vi.fn(),
  stop: vi.fn(),
  // ... 50 more mocks
};

// GOOD: Use real objects when possible, mock only boundaries
const engine = new AudioEngine();
const mockAudioContext = vi.fn();
vi.stubGlobal('AudioContext', mockAudioContext);
```

### ❌ Testing Multiple Things

```typescript
// BAD: Giant test
it('should load, play, pause, stop, and export audio', () => {
  // 100 lines of assertions
});

// GOOD: One behavior per test
it('should load audio file', () => { ... });
it('should play loaded audio', () => { ... });
it('should pause playback', () => { ... });
```

---

## 🚀 Running Tests

```bash
# Watch mode (recommended during development)
npm test

# Visual UI
npm run test:ui

# Coverage report
npm run test:coverage

# Run specific file
npm test CollapsiblePanel

# Run tests matching pattern
npm test -- --grep "collapse"
```

---

## 📚 Further Reading

- [Vitest Documentation](https://vitest.dev)
- [Testing Library Best Practices](https://testing-library.com/docs/guiding-principles)
- ["TDD is not about testing" - Uncle Bob](https://blog.cleancoder.com/uncle-bob/2014/12/17/TheCyclesOfTDD.html)

---

**Remember:** Tests are executable documentation. Write tests like you're explaining the feature to a teammate.
