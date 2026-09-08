import { Vector3 } from 'three';

export function normalOffset(normals: Vector3[], regularization: number): Vector3 {
  const matrix = Array.from({ length: 3 }, (_, row) =>
    Array.from({ length: 3 }, (_, column) => (row === column ? regularization : 0)),
  );
  const right = [0, 0, 0];
  for (const normal of normals)
    for (let row = 0; row < 3; row++) {
      right[row] += normal.getComponent(row);
      for (let column = 0; column < 3; column++)
        matrix[row][column] += normal.getComponent(row) * normal.getComponent(column);
    }
  // Cholesky avoids the determinant cancellation of inverting nearly rank-one normal matrices.
  const lower = Array.from({ length: 3 }, () => [0, 0, 0]);
  for (let row = 0; row < 3; row++)
    for (let column = 0; column <= row; column++) {
      let value = matrix[row][column];
      for (let index = 0; index < column; index++) value -= lower[row][index] * lower[column][index];
      lower[row][column] = row === column ? Math.sqrt(value) : value / lower[column][column];
    }
  const forward = [0, 0, 0];
  for (let row = 0; row < 3; row++) {
    let value = right[row];
    for (let index = 0; index < row; index++) value -= lower[row][index] * forward[index];
    forward[row] = value / lower[row][row];
  }
  const result = [0, 0, 0];
  for (let row = 2; row >= 0; row--) {
    let value = forward[row];
    for (let index = row + 1; index < 3; index++) value -= lower[index][row] * result[index];
    result[row] = value / lower[row][row];
  }
  return new Vector3(...result);
}
