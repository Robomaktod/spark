/**
 * Unit conventions.
 *
 * Spark is deterministic (passport §13): every number that crosses the bot
 * boundary and every number inside the simulation is an integer. Fractions are
 * carried by scaling, never by IEEE floats. This module is the single place
 * where those scales are written down.
 *
 * Base (human) units, and their integer representation:
 *
 *   length        1 cell = 10 cm            stored as milli-cells   (1 cell = 1000)
 *   height        millimetres               stored as-is
 *   time          1 turn = 1 second         stored as milli-turns   (1 turn = 1000)
 *   velocity      cells / turn              stored as milli-cells per turn
 *   mass          grams                     stored as-is
 *   temperature   degrees Celsius           stored as milli-Celsius (20 C = 20000)
 *   energy        joules                    stored as milli-joules
 *   mana          mana                      stored as milli-mana
 *   hit points    HP                        stored as milli-HP
 *   specific heat J/(g*K), relative         stored x1000 (water 1.0 -> 1000)
 *   coefficients  dimensionless             stored x1000 (0.35 -> 350)
 *
 * A cell is 10 cm, so 1 m/s = 10 cells/turn = 10000 milli-cells/turn.
 */

/** Generic fixed-point scale. One unit = 1/1000 of a base unit. */
export const FP_ONE = 1000;

/** Milli-cells in one cell. */
export const MILLI_CELLS_PER_CELL = 1000;

/** Millimetres in one cell edge (a cell is 10 cm x 10 cm x 1 litre). */
export const CELL_SIZE_MM = 100;

/** Milli-cells per metre: 1 m = 10 cells. */
export const MILLI_CELLS_PER_METRE = 10_000;

/** Milli-turns in one turn. One turn is treated as one second (passport §8). */
export const MILLI_TURNS_PER_TURN = 1000;

/** Milli-Celsius in one degree. */
export const MILLI_C_PER_C = 1000;

/** Milli-joules in one joule. */
export const MILLI_J_PER_J = 1000;

/** Milli-mana in one mana. */
export const MILLI_MANA_PER_MANA = 1000;

/** Milli-HP in one HP. */
export const MILLI_HP_PER_HP = 1000;

/** Grams in one kilogram. */
export const GRAMS_PER_KG = 1000;
