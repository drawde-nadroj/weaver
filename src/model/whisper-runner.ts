/**
 * The runner: when a whisper is asked for, and what becomes of the answer.
 *
 * Two entry points, because the writer's two paths through an entry are
 * different. `arm` is speculation during a pause in typing: it (re)starts a
 * short timer, and an answer that arrives before the writer presses `⏎` is
 * cached, so settle can write it inside its own transaction. `request` is settle
 * finding the cache cold: it asks at once and lands the answer through the
 * engine, as its own undoable transaction. Nothing waits on a model.
 *
 * Failures are counted, not reported. Two transport failures in a row and this
 * device stops asking until it reloads — a laptop that has left the machine
 * running oMLX behind should not spend a request per keystroke finding that out.
 * A *validation* failure does not count: the endpoint answered, the writer's
 * register was not met.
 */

import {
  parseWhisperResponse,
  validateWhisper,
  whisperKey,
  whisperPrompt,
  type WhisperInput,
  type WhisperItem
} from "../core/whisper";
import { whisperFailurePhrase } from "../notices";
import { NoModel, type WhisperModel } from "./whisper-model";

/** The idle window before a speculation: long enough to be a pause, short enough to be warm at settle. */
export const WHISPER_IDLE_MS = 800;

/**
 * How long a request must be pending before this device says so.
 *
 * A 4B model on a short entry answers inside this window often enough that an
 * indicator on every request would blink rather than inform. Past it, the wait is
 * a wait and the frame shows it.
 */
export const WHISPER_READING_DELAY_MS = 200;

/** Bounded, because nothing re-proposes: an evicted entry is simply whispered again if asked. */
const CACHE_LIMIT = 16;

/** Two dead addresses in a row and this device stops asking until it reloads. */
export const WHISPER_FAILURE_LIMIT = 2;

/** Where the runner is wired to the rest of the plugin. */
export interface WhisperRunnerOptions {
  /** Read fresh every time: a settings change must take effect without a reload. */
  model: () => WhisperModel;
  /** The deferred write: a cold settle's answer, landed as its own transaction. */
  land: (path: string, n: number, key: string, whisper: WhisperItem[]) => void;
  log: (...args: unknown[]) => void;
  /** Called when the set of entries worth showing as "being read" changes. */
  onChange: () => void;
}

/** Speculates during a pause, answers a cold settle, and remembers what it read. */
export class WhisperRunner {
  private timer: number | null = null;
  private armed: { path: string; n: number; input: WhisperInput } | null = null;
  private readonly cache = new Map<string, WhisperItem[]>();
  /** Requests in flight per entry, and whether that entry has been waiting long enough to show. */
  private readonly pending = new Map<string, { count: number; visible: boolean; timer: number }>();
  private failures = 0;
  private asking = true;

  constructor(private readonly options: WhisperRunnerOptions) {}

  /** True while this device is still asking; false after two failures or a settings change. */
  get live(): boolean {
    return this.asking;
  }

  /** Re-arms the idle timer for this entry; every edit pushes the timer back. */
  arm(path: string, n: number, input: WhisperInput): void {
    if (this.options.model().id === NoModel.id || !this.asking) return;

    this.cancel();
    this.armed = { path, n, input };
    this.timer = window.setTimeout(() => {
      this.timer = null;
      const taken = this.armed;
      this.armed = null;
      if (taken === null) return;

      void this.ask(taken.path, taken.n, taken.input).then((whisper) => {
        if (whisper === null) return;
        this.remember(whisperKey(taken.input), whisper);
      });
    }, WHISPER_IDLE_MS);
  }

  /** The cached whisper for this text, or null. Synchronous: settle must not await. */
  peek(input: WhisperInput): WhisperItem[] | null {
    return this.cache.get(whisperKey(input)) ?? null;
  }

  /**
   * True while this entry is waiting on a request that has outlived the blink
   * window. Synchronous, because a frame repaint must not await anything.
   */
  pendingFor(path: string, n: number): boolean {
    return this.pending.get(this.keyOf(path, n))?.visible === true;
  }

  /** Asks now (settle found the cache cold) and lands the answer when it arrives. */
  request(path: string, n: number, input: WhisperInput): void {
    if (this.options.model().id === NoModel.id || !this.asking) return;

    const key = whisperKey(input);
    void this.ask(path, n, input).then((whisper) => {
      if (whisper === null) return;
      this.remember(key, whisper);
      this.options.land(path, n, key, whisper);
    });
  }

  /** Cancels the timers and empties the cache: a settings change, or unload. */
  clear(): void {
    this.cancel();

    let shown = false;
    for (const entry of this.pending.values()) {
      window.clearTimeout(entry.timer);
      shown ||= entry.visible;
    }
    this.pending.clear();
    if (shown) this.options.onChange();

    this.cache.clear();
    this.failures = 0;
    this.asking = true;
  }

  private cancel(): void {
    if (this.timer === null) return;
    window.clearTimeout(this.timer);
    this.timer = null;
    this.armed = null;
  }

  /**
   * One round trip, and the answer held to the writer's register.
   *
   * `null` means "no whisper", for either reason: the endpoint did not answer
   * (counted), or it answered something this note cannot carry (not counted).
   */
  private async ask(path: string, n: number, input: WhisperInput): Promise<WhisperItem[] | null> {
    this.begin(path, n);

    try {
      return await this.read(input);
    } finally {
      this.end(path, n);
    }
  }

  /** One completion, held to the writer's register; `null` is "no whisper". */
  private async read(input: WhisperInput): Promise<WhisperItem[] | null> {
    const reply = await this.options.model().complete(whisperPrompt(input));
    if (!reply.ok) {
      this.failures += 1;
      if (this.failures >= WHISPER_FAILURE_LIMIT && this.asking) {
        this.asking = false;
        this.options.log(`whisper: ${whisperFailurePhrase(reply.failure)}, quiet until reload`);
      }
      return null;
    }

    const answer = validateWhisper(parseWhisperResponse(reply.text), input);
    if (!answer.ok) {
      this.options.log("whisper rejected", answer.reason);
      return null;
    }
    return answer.whisper;
  }

  /**
   * Marks a request in flight, and says so once it has outlived the blink
   * window. The count is what makes a speculation and a settle's own request for
   * the same entry one indicator rather than two.
   */
  private begin(path: string, n: number): void {
    const key = this.keyOf(path, n);
    const existing = this.pending.get(key);
    if (existing !== undefined) {
      existing.count += 1;
      return;
    }

    const entry = { count: 1, visible: false, timer: 0 };
    entry.timer = window.setTimeout(() => {
      entry.visible = true;
      this.options.onChange();
    }, WHISPER_READING_DELAY_MS);
    this.pending.set(key, entry);
  }

  /** Clears the mark, and the indicator with it, once no request is left on it. */
  private end(path: string, n: number): void {
    const key = this.keyOf(path, n);
    const entry = this.pending.get(key);
    if (entry === undefined) return;

    entry.count -= 1;
    if (entry.count > 0) return;

    window.clearTimeout(entry.timer);
    this.pending.delete(key);
    if (entry.visible) this.options.onChange();
  }

  private keyOf(path: string, n: number): string {
    return `${path}\u0000${n}`;
  }

  private remember(key: string, whisper: WhisperItem[]): void {
    this.cache.set(key, whisper);
    if (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.options.log("whisper", key, whisper);
  }
}
