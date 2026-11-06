// Motion grammar shared by every component (see the app's UI standards): entrances ease out, touchable things
// spring, lists stagger. Reuse these instead of hand-picking durations.
import type { Transition, Variants } from "framer-motion";

/** Element entrance: opacity 0 -> 1, y 12 -> 0, easeOut 0.4 s. */
export const entrance = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.4, ease: "easeOut" } satisfies Transition,
};

/** Hover / tap micro-interactions. */
export const spring: Transition = { type: "spring", stiffness: 500, damping: 30 };

/** Drawers and panels settling into place. */
export const settle: Transition = { type: "spring", stiffness: 260, damping: 30 };

/** Parent + child variants for staggered lists: <motion.ul variants={stagger} initial="hidden" animate="show">. */
export const stagger: Variants = { hidden: {}, show: { transition: { staggerChildren: 0.06 } } };
export const staggerItem: Variants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" } },
};
