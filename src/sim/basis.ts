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
