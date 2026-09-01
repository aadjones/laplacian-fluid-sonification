/**
 * Laplacian eigenfunction basis for 2D fluid simulation.
 *
 * Eigenfunctions of the Laplacian on [0,π]² with Dirichlet BCs.
 * Each mode (k1,k2) has eigenvalue λ = -(k1² + k2²).
 *
 * Velocity eigenfunction (curl of stream function):
 *   u(x,y) =  (k2 / λ) · sin(k1·x) · cos(k2·y)
 *   v(x,y) = -(k1 / λ) · cos(k1·x) · sin(k2·y)
 *
 * Vorticity eigenfunction:
 *   ω(x,y) = sin(k1·x) · sin(k2·y)
 *
 * Reference: De Witt et al., "Fluid Simulation Using Laplacian Eigenfunctions"
 */

export interface IjPair {
  k1: number;
  k2: number;
}

/**
 * Build the ordered list of (k1,k2) mode pairs used as basis.
 * Follows the C++ reference: triangular enumeration up to `rank` modes.
 * Pairs are ordered by increasing max(k1,k2), with (i,j) and (j,i) both included when i≠j.
 */
export function buildIjPairs(rank: number): IjPair[] {
  const pairs: IjPair[] = [];

  for (let i = 1; i <= rank; i++) {
    for (let j = 1; j <= i; j++) {
      pairs.push({ k1: i, k2: j });
      if (pairs.length === rank) return pairs;

      if (i === j) continue;

      pairs.push({ k1: j, k2: i });
      if (pairs.length === rank) return pairs;
    }
  }

  return pairs;
}

/**
 * Build reverse lookup: (k1,k2) → index in pairs array.
 * Returns -1 for pairs not in the basis.
 */
export function buildIjReverse(pairs: IjPair[]): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < pairs.length; i++) {
    map.set(`${pairs[i].k1},${pairs[i].k2}`, i);
  }
  return map;
}

function ijKey(k1: number, k2: number): string {
  return `${k1},${k2}`;
}

/**
 * Build the velocity basis matrix U.
 * U is (2·xRes·yRes) × rank — each column is a flattened velocity eigenfunction.
 * Stored as flat Float64Array in column-major order.
 */
export function buildVelocityBasis(
  pairs: IjPair[],
  xRes: number,
  yRes: number,
): Float64Array {
  const rank = pairs.length;
  const fieldSize = xRes * yRes;
  const rowCount = 2 * fieldSize; // u,v components
  const U = new Float64Array(rowCount * rank);

  const dx = Math.PI / (xRes - 1);
  const dy = Math.PI / (yRes - 1);

  for (let col = 0; col < rank; col++) {
    const { k1, k2 } = pairs[col];
    const invLambda = 1.0 / (k1 * k1 + k2 * k2);
    const colOffset = col * rowCount;

    for (let iy = 0; iy < yRes; iy++) {
      const yReal = iy * dy;
      for (let ix = 0; ix < xRes; ix++) {
        const xReal = ix * dx;
        const idx = iy * xRes + ix;

        // u component: invLambda * k2 * sin(k1*x) * cos(k2*y)
        U[colOffset + idx] = invLambda * k2 * Math.sin(k1 * xReal) * Math.cos(k2 * yReal);
        // v component: -invLambda * k1 * cos(k1*x) * sin(k2*y)
        U[colOffset + fieldSize + idx] = -invLambda * k1 * Math.cos(k1 * xReal) * Math.sin(k2 * yReal);
      }
    }
  }

  return U;
}

/**
 * Analytic structure coefficient C(a,b,k) encoding nonlinear advection.
 *
 * Uses the closed-form from trig product-to-sum identities (same as
 * VECTOR3_FIELD_2D::structureCoefficientAnalytic in the C++ reference).
 *
 * Only certain (a,b,k) triples produce nonzero values due to selection rules.
 */
function structureCoefficientAnalytic(
  a1: number, a2: number,
  b1: number, b2: number,
  k1: number, k2: number,
): number {
  let leftSign1 = 0, rightSign1 = 0;
  if (a1 === b1 + k1) { leftSign1 = -1; rightSign1 = 1; }
  if (a1 + b1 === k1) { leftSign1 = 1; rightSign1 = 1; }
  if (a1 + k1 === b1) { leftSign1 = 1; rightSign1 = -1; }

  let leftSign2 = 0, rightSign2 = 0;
  if (a2 === b2 + k2) { leftSign2 = 1; rightSign2 = -1; }
  if (a2 + b2 === k2) { leftSign2 = 1; rightSign2 = 1; }
  if (a2 + k2 === b2) { leftSign2 = -1; rightSign2 = 1; }

  if (leftSign1 * rightSign1 * leftSign2 * rightSign2 === 0) return 0;

  return 0.25 * (b2 * a1 * leftSign1 * leftSign2 - b1 * a2 * rightSign1 * rightSign2)
    / (b1 * b1 + b2 * b2);
}

/**
 * Build the 3D structure tensor C[rank][rank][rank].
 * C is stored as a flat Float64Array: C[b * rank * rank + a * rank + k].
 *
 * C(b,a,k) = structureCoefficient(a_pair, b_pair, k_pair)
 * Used in the advection step: wDot[k] = w · (C_slab_k · w)
 */
export function buildStructureTensor(pairs: IjPair[]): Float64Array {
  const rank = pairs.length;
  const C = new Float64Array(rank * rank * rank);

  const reverse = buildIjReverse(pairs);

  for (let d1 = 0; d1 < rank; d1++) {
    const { k1: a1, k2: a2 } = pairs[d1];
    for (let d2 = 0; d2 < rank; d2++) {
      const { k1: b1, k2: b2 } = pairs[d2];

      const a = reverse.get(ijKey(a1, a2))!;
      const b = reverse.get(ijKey(b1, b2))!;

      for (let d3 = 0; d3 < rank; d3++) {
        const { k1, k2 } = pairs[d3];
        const k = reverse.get(ijKey(k1, k2))!;

        const coef = structureCoefficientAnalytic(a1, a2, b1, b2, k1, k2);
        // C(b, a, k) = coef — matches C++ reference indexing
        C[b * rank * rank + a * rank + k] = coef;
      }
    }
  }

  return C;
}

/**
 * Extract slab k from the structure tensor: a rank×rank matrix.
 * slab_k[b][a] = C[b * rank * rank + a * rank + k]
 */
export function getSlabK(C: Float64Array, rank: number, k: number): Float64Array {
  const slab = new Float64Array(rank * rank);
  for (let b = 0; b < rank; b++) {
    for (let a = 0; a < rank; a++) {
      slab[b * rank + a] = C[b * rank * rank + a * rank + k];
    }
  }
  return slab;
}

/**
 * Sparse form of the structure tensor.
 *
 * C is dominated by zeros: the trig product-to-sum identities behind
 * structureCoefficientAnalytic only admit k1 in {a1-b1, a1+b1, b1-a1} and
 * likewise for k2, so at most nine (k1,k2) candidates survive per (a,b) pair.
 * Measured density at rank 256 is well under 1%, and the dense array would be
 * rank^3 = 16.7M doubles (134 MB). Storing only the nonzeros turns the advection
 * step from O(rank^3) into O(nnz).
 */
export interface SparseTensor {
  readonly nnz: number;
  readonly ks: Int32Array;
  readonly as: Int32Array;
  readonly bs: Int32Array;
  readonly coeffs: Float64Array;
}

/**
 * Build the structure tensor in sparse form.
 *
 * Enumerates only the (k1,k2) admitted by the selection rules instead of
 * sweeping all rank^3 triples, then evaluates the same analytic coefficient, so
 * the stored values are identical to buildStructureTensor's nonzeros.
 */
export function buildSparseTensor(pairs: IjPair[]): SparseTensor {
  const rank = pairs.length;
  const reverse = buildIjReverse(pairs);

  const ks: number[] = [];
  const as: number[] = [];
  const bs: number[] = [];
  const coeffs: number[] = [];

  for (let a = 0; a < rank; a++) {
    const { k1: a1, k2: a2 } = pairs[a];
    for (let b = 0; b < rank; b++) {
      const { k1: b1, k2: b2 } = pairs[b];

      // Selection rules: only these k can give a nonzero coefficient.
      const cand1 = [a1 - b1, a1 + b1, b1 - a1];
      const cand2 = [a2 - b2, a2 + b2, b2 - a2];

      for (let i = 0; i < 3; i++) {
        const k1 = cand1[i];
        if (k1 < 1) continue;
        if (cand1.indexOf(k1) !== i) continue; // dedupe repeated candidates
        for (let j = 0; j < 3; j++) {
          const k2 = cand2[j];
          if (k2 < 1) continue;
          if (cand2.indexOf(k2) !== j) continue;

          const k = reverse.get(ijKey(k1, k2));
          if (k === undefined) continue;

          const coef = structureCoefficientAnalytic(a1, a2, b1, b2, k1, k2);
          if (coef === 0) continue;

          ks.push(k);
          as.push(a);
          bs.push(b);
          coeffs.push(coef);
        }
      }
    }
  }

  return {
    nnz: coeffs.length,
    ks: Int32Array.from(ks),
    as: Int32Array.from(as),
    bs: Int32Array.from(bs),
    coeffs: Float64Array.from(coeffs),
  };
}

/**
 * Precomputed tables for separable velocity reconstruction.
 *
 * The eigenfunction is a product of a function of x and a function of y, so the
 * field never needs the explicit (2*xRes*yRes) x rank matrix U — which is 67 MB
 * at rank 256 and costs rank*xRes*yRes multiply-adds per frame to apply.
 * Grouping the modes by k1 lets reconstruction run as two passes instead:
 * O(rank*yRes) to collapse each k1 group over y, then O(maxK1*xRes*yRes) to
 * sweep x. At rank 256 that is ~16x fewer operations and no matrix at all.
 */
export interface SeparableBasis {
  readonly maxK: number;
  readonly xRes: number;
  readonly yRes: number;
  /** sin(k*x) / cos(k*x) indexed [k * xRes + ix]; likewise for y. */
  readonly sinX: Float64Array;
  readonly cosX: Float64Array;
  readonly sinY: Float64Array;
  readonly cosY: Float64Array;
  /** Modes sharing a k1, as groupModes[groupStart[k1] .. groupStart[k1+1]). */
  readonly groupStart: Int32Array;
  readonly groupModes: Int32Array;
}

export function buildSeparableBasis(pairs: IjPair[], xRes: number, yRes: number): SeparableBasis {
  const rank = pairs.length;
  let maxK = 1;
  for (const p of pairs) {
    if (p.k1 > maxK) maxK = p.k1;
    if (p.k2 > maxK) maxK = p.k2;
  }

  const dx = Math.PI / (xRes - 1);
  const dy = Math.PI / (yRes - 1);
  const sinX = new Float64Array((maxK + 1) * xRes);
  const cosX = new Float64Array((maxK + 1) * xRes);
  const sinY = new Float64Array((maxK + 1) * yRes);
  const cosY = new Float64Array((maxK + 1) * yRes);

  for (let k = 1; k <= maxK; k++) {
    for (let ix = 0; ix < xRes; ix++) {
      sinX[k * xRes + ix] = Math.sin(k * ix * dx);
      cosX[k * xRes + ix] = Math.cos(k * ix * dx);
    }
    for (let iy = 0; iy < yRes; iy++) {
      sinY[k * yRes + iy] = Math.sin(k * iy * dy);
      cosY[k * yRes + iy] = Math.cos(k * iy * dy);
    }
  }

  // Bucket mode indices by k1 (counting sort).
  const counts = new Int32Array(maxK + 2);
  for (let m = 0; m < rank; m++) counts[pairs[m].k1 + 1]++;
  const groupStart = new Int32Array(maxK + 2);
  for (let k = 1; k <= maxK + 1; k++) groupStart[k] = groupStart[k - 1] + counts[k];
  const cursor = Int32Array.from(groupStart);
  const groupModes = new Int32Array(rank);
  for (let m = 0; m < rank; m++) groupModes[cursor[pairs[m].k1]++] = m;

  return { maxK, xRes, yRes, sinX, cosX, sinY, cosY, groupStart, groupModes };
}
