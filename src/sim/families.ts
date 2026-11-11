/**
 * Harmonic mode families ("stacks").
 *
 * λ(np,nq) = n²·λ(p,q), so under the √λ mapping the modes (p,q), (2p,2q),
 * (3p,3q), … land on f₀, 2f₀, 3f₀, … — an exact harmonic series. A primitive
 * coprime pair (p,q) therefore names a stack the ear fuses into a single note
 * with timbre, while distinct stacks sit at √(integer) ratios to one another,
 * which are irrational and read as bell-like. Harmonic notes on an inharmonic
 * scale, and none of it composed: it falls out of the basis.
 *
 * Why sonify a stack instead of the whole rank. At rank 256 the spectrum is
 * below the ear's resolution: 122 distinct pitches across 4 octaves puts 119 of
 * 121 adjacent pairs inside one critical band, with median gaps of 6–10 cents.
 * Partials the cochlea cannot separate are heard as roughness and then as noise,
 * so the extra modes buy no pitch at all — they only add wind. Sparsity is the
 * only fix, and the family structure is sparsity that is also harmonic.
 *
 * A stack is only *approximately* invariant under advection. The product-to-sum
 * identities behind the structure coefficients choose the x and y signs
 * independently, so n(p,q) × m(p,q) also emits ((n+m)p, (n−m)q), which leaves
 * the family. Measured inviscid at rank 256 from a struck stack, in-family
 * enstrophy runs 99.9% at 0.1 s and settles around 66–86% over several seconds,
 * sloshing back rather than draining away: the note holds its identity and
 * colours outward. Isolation is therefore enforced at the output (see
 * `Sonifier.setModeMask`), not assumed from the physics.
 */

import type { IjPair } from './basis';

export interface HarmonicFamily {
  readonly p: number;
  readonly q: number;
  /** Indices into the pairs array for (p,q), (2p,2q), … in ascending n. */
  readonly members: number[];
  /** "(2,1)" — the primitive pair, which is the stack's name. */
  readonly label: string;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * Enumerate the harmonic families present in `pairs`, richest first.
 *
 * Only coprime (p,q) name a family: (2,2) is already the second harmonic of
 * (1,1) and would otherwise duplicate that stack's tail. Transpose twins
 * (p,q) and (q,p) are kept as separate families — they are degenerate in λ, so
 * they carry identical frequencies over different spatial orientations, which
 * is the one handle this basis offers on stereo width and on rotating the
 * standing pattern without changing the pitch.
 *
 * `minMembers` filters out stacks too short to fuse: at rank 256 there are 159
 * primitive families, 43 with ≥2 members and 19 with ≥3.
 *
 * `maxHarmonics` truncates the long end, and is a timbre control rather than a
 * technicality. Two things go wrong when a stack runs too deep:
 *
 *  - The ear resolves only about the first 7–8 harmonics of a series. Past that
 *    the partials fall inside one critical band and add buzz, not pitch, which
 *    is most of the difference between a flute and a sawtooth.
 *  - The filter bank's Q ∝ 1/√λ means bandwidth grows as n² while harmonic
 *    spacing stays at f₀. For (1,1), where Q is exactly 240/n, the two cross at
 *    n=16: above that the bandpasses overlap into one continuous noise band
 *    rather than a comb of partials. Other families cross later, because a
 *    higher fundamental buys a wider gap.
 *
 * The count also drives how far the fluid is driven, since a stack only extends
 * as far as it is struck.
 */
export function buildFamilies(
  pairs: IjPair[],
  minMembers = 2,
  maxHarmonics = Infinity,
): HarmonicFamily[] {
  const index = new Map<string, number>();
  pairs.forEach((pr, i) => index.set(`${pr.k1},${pr.k2}`, i));

  const families: HarmonicFamily[] = [];
  for (const { k1: p, k2: q } of pairs) {
    if (gcd(p, q) !== 1) continue;

    const members: number[] = [];
    for (let n = 1; ; n++) {
      const k = index.get(`${n * p},${n * q}`);
      if (k === undefined) break;
      members.push(k);
    }
    if (members.length > maxHarmonics) members.length = maxHarmonics;
    if (members.length >= minMembers) {
      families.push({ p, q, members, label: `(${p},${q})` });
    }
  }

  // Most harmonics first (that is most strongly pitched), then lowest
  // fundamental, so cycling walks from the richest note outward.
  families.sort(
    (a, b) =>
      b.members.length - a.members.length ||
      (a.p * a.p + a.q * a.q) - (b.p * b.p + b.q * b.q),
  );
  return families;
}

/** 1 on this family's modes, 0 elsewhere. Feeds the sonifier and the underlay. */
export function familyMask(rank: number, family: HarmonicFamily): Float64Array {
  const mask = new Float64Array(rank);
  for (const k of family.members) mask[k] = 1;
  return mask;
}

/**
 * Strike a stack: add `amplitude * weight_n` to the nth harmonic.
 *
 * The 1/n rolloff is the spectrum of a sawtooth, which is what a struck or
 * bowed body tends toward, and it puts most of the energy in the fundamental so
 * the pitch is unambiguous from the first frame. This is the mode-space
 * counterpart of `injectImpulse`: instead of hitting the fluid at a point and
 * taking whatever spectrum the projection gives, it plays a note.
 *
 * `position` is the hammer's fractional strike point; see `strikeWeights`. The
 * default of 0 is the plain 1/n series, so existing callers are unchanged.
 */
export function strikeFamily(
  w: Float64Array,
  family: HarmonicFamily,
  amplitude: number,
  position = 0,
): void {
  const weights = strikeWeights(family, position);
  family.members.forEach((k, i) => {
    w[k] += amplitude * weights[i];
  });
}

/**
 * Per-harmonic strike amplitudes, indexed by position in `family.members`.
 *
 * Two factors multiply:
 *
 *  - **1/n**, the sawtooth rolloff a struck body tends toward. It puts most of
 *    the energy in the fundamental, so the pitch is unambiguous from the first
 *    millisecond.
 *  - **|sin(nπx)|** for a strike at fractional position `x` along the mode's
 *    antinode axis. A hammer landing on a node of the nth partial cannot excite
 *    it at all. This is why a piano's hammer meets the string near 1/7 of its
 *    length: it notches out the septimal partial, which is 231 cents flat of a
 *    minor seventh and sours every chord it appears in. `x = 0` disables the
 *    notch and returns the plain 1/n series.
 *
 * The notch is the cheapest real timbre control the instrument has. It is one
 * multiply, it is exactly what a luthier moves when they reposition a hammer or
 * a plucking point, and unlike a filter it changes *which* partials exist
 * rather than how loud the whole note is.
 */
export function strikeWeights(family: HarmonicFamily, position = 0): number[] {
  return family.members.map((_, i) => {
    const n = i + 1;
    const notch = position > 0 ? Math.abs(Math.sin(n * Math.PI * position)) : 1;
    return notch / n;
  });
}

/**
 * The same weights as a rank-length vector, for handing to the sonifier.
 *
 * The audio layer is deliberately kept ignorant of families — strategies see
 * only w, frequencies and eigenvalues — so a strike crosses the boundary as a
 * plain per-mode amplitude vector rather than as a family object.
 */
export function strikeVector(rank: number, family: HarmonicFamily, position = 0): Float64Array {
  const v = new Float64Array(rank);
  const weights = strikeWeights(family, position);
  family.members.forEach((k, i) => {
    if (k < rank) v[k] = weights[i];
  });
  return v;
}
