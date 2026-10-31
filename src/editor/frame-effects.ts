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
 * `is-whispering` outranks `is-live` on purpose: a draft is liveness, and the
 * model speculating over that draft is a request in flight, so both are true at
 * once — and the transient fact is the one worth the animation. One box, one
 * motion, and it answers "what is happening now?".
 */
export const FRAME_EFFECTS: readonly FrameEffect[] = [
  {
    className: "is-whispering",
    precedence: 20,
    active: (activity) => activity.reading
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
