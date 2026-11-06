/**
 * What a drawn frame can be doing, and which single effect shows it.
 *
 * A box carries at most one effect class at a time, chosen by precedence, so two
 * states never animate over each other. That is the whole rule: adding an effect
 * is one entry in `FRAME_EFFECTS` and one block in `styles.css`. Nothing in
 * `entry-frame.ts` changes, and no surface learns a new name.
 *
 * Pure and Obsidian-free: the frame layer asks what to show, and the stylesheet
 * decides what showing it looks like.
 */

/** The states the frame layer can observe about one entry. */
export interface FrameActivity {
  /** True while this entry's clock is running: the writer is in it. */
  live: boolean;
  /** True while a whisper request for this entry has been pending long enough to be a wait. */
  reading: boolean;
  /** True while this entry was captured through a portal (validated against recorded history). */
  portal: boolean;
  /** True for the short acknowledgment after a captured portal alignment was recognised. */
  aligned: boolean;
}

/** One frame effect: the class it paints, when it applies, and what outranks what. */
export interface FrameEffect {
  /** The class the box carries while this effect is the one showing. */
  className: string;
  /** Higher wins when more than one applies; a tie keeps list order. */
  precedence: number;
  active(activity: FrameActivity): boolean;
}

/**
 * Every effect a frame can show.
 *
 * Precedence, highest first, is a statement about transience:
 *
 * - `is-aligned` (30) is one 800 ms acknowledgment of a captured alignment. The
 *   recognition is the news; it outranks everything and then yields, because the
 *   plugin removes the acknowledgment from the activity after it has played.
 * - `is-whispering` (20) is a request in flight: the model speculating over the
 *   draft is more transient than the draft itself.
 * - `is-portal-live` (15) is a captured portal entry being written. It is a
 *   narrower fact than "an entry is live" — the entry came through a portal, and
 *   its frame says so with a slow colour pulse rather than the ordinary travel.
 * - `is-live` (10) is the ordinary running clock, and stays exactly as it was.
 *
 * A paused portal entry is static: `is-portal-live` requires `live`, so a
 * captured portal that is not being written carries no animation at all.
 */
export const FRAME_EFFECTS: readonly FrameEffect[] = [
  {
    className: "is-aligned",
    precedence: 30,
    active: (activity) => activity.aligned
  },
  {
    className: "is-whispering",
    precedence: 20,
    active: (activity) => activity.reading
  },
  {
    className: "is-portal-live",
    precedence: 15,
    active: (activity) => activity.portal && activity.live
  },
  {
    className: "is-live",
    precedence: 10,
    active: (activity) => activity.live
  }
];

/** The one effect a box shows for this activity, or null when nothing is happening. */
export function frameEffect(activity: FrameActivity): FrameEffect | null {
  let chosen: FrameEffect | null = null;

  for (const effect of FRAME_EFFECTS) {
    if (!effect.active(activity)) continue;
    if (chosen === null || effect.precedence > chosen.precedence) chosen = effect;
  }

  return chosen;
}
