/**
 * 리스트 가상화(Virtualization) 계산
 *
 * 왜 필요한가
 * -----------
 * 10만 행을 `<tr>`로 그리면 DOM 노드가 수십만 개가 된다. 브라우저는 레이아웃·페인트에
 * 수 초를 쓰고, 스크롤 한 번에 프레임이 5fps로 떨어진다. 실제로 화면에 보이는 행은 30~40개뿐이다.
 *
 * 그래서 "뷰포트에 보이는 구간"만 계산해서 그 구간만 렌더링한다. 핵심은 그 계산이
 * **O(1) 또는 O(log n)** 이어야 한다는 점이다. 스크롤 이벤트마다 전체 배열을 훑으면
 * 가상화를 해도 프레임이 죽는다.
 *
 * - 고정 행 높이: 나눗셈 한 번(O(1))
 * - 가변 행 높이: 누적 합 배열 + 이진 탐색(O(log n))
 *
 * 이 파일은 DOM을 모르는 순수 함수 모음이라 브라우저 없이 테스트할 수 있다.
 */

export interface FixedWindowInput {
  scrollTop: number;
  viewportHeight: number;
  rowHeight: number;
  rowCount: number;
  /** 화면 위/아래로 미리 그릴 행 수 (빠른 스크롤 시 흰 줄 방지) */
  overscan?: number;
}

export interface VirtualWindow {
  /** 렌더링 시작 인덱스(포함) */
  startIndex: number;
  /** 렌더링 끝 인덱스(제외) */
  endIndex: number;
  /** 컨테이너 위쪽 spacer 높이(px) */
  paddingTop: number;
  /** 컨테이너 아래쪽 spacer 높이(px) */
  paddingBottom: number;
  /** 전체 스크롤 높이(px) */
  totalHeight: number;
  /** 실제로 DOM에 그려질 행 수 */
  renderedCount: number;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/**
 * 고정 행 높이 가상화 구간 계산.
 *
 * `scrollTop`이 음수이거나 콘텐츠보다 큰 경우(바운스 스크롤, iOS 러버밴드)에도
 * 음수 인덱스나 배열 범위를 벗어난 인덱스를 내보내지 않는다.
 */
export function computeVirtualWindow(input: FixedWindowInput): VirtualWindow {
  const rowHeight = input.rowHeight > 0 ? input.rowHeight : 1;
  const rowCount = Math.max(0, Math.floor(input.rowCount));
  const viewportHeight = Math.max(0, input.viewportHeight);
  const overscan = Math.max(0, Math.floor(input.overscan ?? 6));

  const totalHeight = rowCount * rowHeight;
  if (rowCount === 0) {
    return { startIndex: 0, endIndex: 0, paddingTop: 0, paddingBottom: 0, totalHeight: 0, renderedCount: 0 };
  }

  const maxScrollTop = Math.max(0, totalHeight - viewportHeight);
  const scrollTop = clamp(input.scrollTop, 0, maxScrollTop);

  const firstVisible = Math.floor(scrollTop / rowHeight);
  const visibleCount = Math.max(1, Math.ceil(viewportHeight / rowHeight));
  const lastVisible = firstVisible + visibleCount;

  const startIndex = clamp(firstVisible - overscan, 0, rowCount);
  const endIndex = clamp(lastVisible + overscan, 0, rowCount);
  const renderedCount = endIndex - startIndex;

  return {
    startIndex,
    endIndex,
    paddingTop: startIndex * rowHeight,
    paddingBottom: Math.max(0, totalHeight - endIndex * rowHeight),
    totalHeight,
    renderedCount,
  };
}

/** 행 높이 배열 → 누적 합 배열(길이 = 행 수 + 1). offsets[i]는 i번째 행의 상단 y좌표. */
export function buildRowOffsets(rowHeights: readonly number[]): number[] {
  const offsets = new Array<number>(rowHeights.length + 1);
  offsets[0] = 0;
  for (let index = 0; index < rowHeights.length; index += 1) {
    offsets[index + 1] = (offsets[index] ?? 0) + Math.max(0, rowHeights[index] ?? 0);
  }
  return offsets;
}

/**
 * 누적 합 배열에서 `scrollTop`이 속한 행 인덱스를 이진 탐색으로 찾는다.
 * 반환값은 scrollTop을 포함하는 마지막 행 인덱스(0-based)이며, 범위를 벗어나지 않는다.
 */
export function findRowIndexByOffset(offsets: readonly number[], scrollTop: number): number {
  const rowCount = offsets.length - 1;
  if (rowCount <= 0) return 0;

  let low = 0;
  let high = rowCount - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((offsets[mid] ?? 0) <= scrollTop) low = mid;
    else high = mid - 1;
  }
  return low;
}

export interface VariableWindowInput {
  /** buildRowOffsets 결과 */
  offsets: readonly number[];
  scrollTop: number;
  viewportHeight: number;
  overscan?: number;
}

/**
 * 가변 행 높이 가상화 구간 계산.
 * 상세 드로어가 열리거나 메모가 두 줄로 늘어나는 표에서 필요하다.
 */
export function computeVariableWindow(input: VariableWindowInput): VirtualWindow {
  const rowCount = Math.max(0, input.offsets.length - 1);
  const totalHeight = rowCount > 0 ? (input.offsets[rowCount] ?? 0) : 0;
  if (rowCount === 0) {
    return { startIndex: 0, endIndex: 0, paddingTop: 0, paddingBottom: 0, totalHeight: 0, renderedCount: 0 };
  }

  const viewportHeight = Math.max(0, input.viewportHeight);
  const overscan = Math.max(0, Math.floor(input.overscan ?? 4));
  const maxScrollTop = Math.max(0, totalHeight - viewportHeight);
  const scrollTop = clamp(input.scrollTop, 0, maxScrollTop);

  const firstVisible = findRowIndexByOffset(input.offsets, scrollTop);
  const bottomEdge = scrollTop + viewportHeight;
  let lastVisible = firstVisible;
  while (lastVisible + 1 < rowCount && (input.offsets[lastVisible + 1] ?? 0) < bottomEdge) {
    lastVisible += 1;
  }

  const startIndex = clamp(firstVisible - overscan, 0, rowCount);
  const endIndex = clamp(lastVisible + 1 + overscan, 0, rowCount);

  return {
    startIndex,
    endIndex,
    paddingTop: input.offsets[startIndex] ?? 0,
    paddingBottom: Math.max(0, totalHeight - (input.offsets[endIndex] ?? totalHeight)),
    totalHeight,
    renderedCount: endIndex - startIndex,
  };
}

/**
 * DOM 노드 절감 추정.
 * 10만 행 × 9열이면 90만 개 노드가 필요하지만, 가상화하면 화면에 보이는 행만 그린다.
 * 화면의 "DOM 절감" 숫자를 지어내지 않고 계산으로 내기 위한 함수다.
 */
export function estimateDomNodes(
  rowCount: number,
  renderedCount: number,
  cellsPerRow = 9,
): { full: number; virtual: number; ratio: number } {
  const rows = Math.max(0, Math.floor(rowCount));
  const rendered = Math.max(0, Math.floor(renderedCount));
  return {
    full: rows * cellsPerRow,
    virtual: rendered * cellsPerRow,
    ratio: rendered > 0 ? Math.round((rows / rendered) * 10) / 10 : 0,
  };
}
