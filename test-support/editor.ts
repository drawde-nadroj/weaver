/* An Obsidian `Editor` stand-in with real offset arithmetic, so planner output
 * can be applied and read back. Test support only. */

export class FakeEditor {
  value: string;
  cursor = { line: 0, ch: 0 };
  selection = { from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 } };
  undoStack: string[] = [];
  transactions = 0;
  focusCalls = 0;
  blurCalls = 0;

  constructor(value: string) {
    this.value = value;
  }

  getValue(): string {
    return this.value;
  }

  getCursor(): { line: number; ch: number } {
    return { ...this.cursor };
  }

  setCursor(position: { line: number; ch: number }): void {
    this.cursor = { ...position };
    this.selection = { from: { ...position }, to: { ...position } };
  }

  /** Test helper: select a range, the way a drag leaves the editor. */
  select(from: { line: number; ch: number }, to: { line: number; ch: number } = from): void {
    this.selection = { from: { ...from }, to: { ...to } };
    this.cursor = { ...to };
  }

  listSelections(): Array<{ anchor: { line: number; ch: number }; head: { line: number; ch: number } }> {
    return [{ anchor: { ...this.selection.from }, head: { ...this.selection.to } }];
  }

  getRange(from: { line: number; ch: number }, to: { line: number; ch: number }): string {
    return this.value.slice(this.posToOffset(from), this.posToOffset(to));
  }

  posToOffset(position: { line: number; ch: number }): number {
    const lines = this.value.split("\n");
    let offset = 0;
    for (let index = 0; index < position.line; index += 1) {
      offset += (lines[index] ?? "").length + 1;
    }
    return offset + position.ch;
  }

  offsetToPos(offset: number): { line: number; ch: number } {
    const before = this.value.slice(0, Math.max(0, Math.min(offset, this.value.length)));
    const lines = before.split("\n");
    return { line: lines.length - 1, ch: (lines[lines.length - 1] ?? "").length };
  }

  transaction(transaction: {
    changes?: Array<{ from: { line: number; ch: number }; to?: { line: number; ch: number }; text: string }>;
    selection?: { from: { line: number; ch: number }; to?: { line: number; ch: number } } | { line: number; ch: number };
  }): void {
    this.transactions += 1;
    this.undoStack.push(this.value);

    const changes = [...(transaction.changes ?? [])].sort(
      (left, right) => this.posToOffset(right.from) - this.posToOffset(left.from)
    );
    for (const change of changes) {
      const from = this.posToOffset(change.from);
      const to = change.to === undefined ? from : this.posToOffset(change.to);
      this.value = this.value.slice(0, from) + change.text + this.value.slice(to);
    }

    if (transaction.selection !== undefined) {
      const selection = transaction.selection;
      if ("line" in selection) {
        this.selection = { from: selection, to: selection };
      } else {
        const to = selection.to ?? selection.from;
        this.selection = { from: selection.from, to };
      }
      this.cursor = { ...this.selection.to };
    }
  }

  undo(): boolean {
    const previous = this.undoStack.pop();
    if (previous === undefined) return false;
    this.value = previous;
    return true;
  }

  focus(): void {
    this.focusCalls += 1;
  }

  blur(): void {
    this.blurCalls += 1;
  }

  scrollIntoView(): void {}

  lineCount(): number {
    return this.value.split("\n").length;
  }

  getSelection(): string {
    return this.value.slice(
      this.posToOffset(this.selection.from),
      this.posToOffset(this.selection.to)
    );
  }
}
