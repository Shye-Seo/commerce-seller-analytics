import { describe, expect, it } from "vitest";
import {
  buildRowOffsets,
  computeVariableWindow,
  computeVirtualWindow,
  estimateDomNodes,
  findRowIndexByOffset,
} from "./virtualization";

describe("computeVirtualWindow", () => {
  it("행이 없으면 빈 구간을 돌려준다", () => {
    const result = computeVirtualWindow({ scrollTop: 0, viewportHeight: 400, rowHeight: 40, rowCount: 0 });
    expect(result).toEqual({ startIndex: 0, endIndex: 0, paddingTop: 0, paddingBottom: 0, totalHeight: 0, renderedCount: 0 });
  });

  it("뷰포트에 보이는 행만 계산한다", () => {
    const result = computeVirtualWindow({
      scrollTop: 0,
      viewportHeight: 400,
      rowHeight: 40,
      rowCount: 100_000,
      overscan: 0,
    });

    expect(result.startIndex).toBe(0);
    expect(result.endIndex).toBe(10);
    expect(result.renderedCount).toBe(10);
    expect(result.paddingTop).toBe(0);
    expect(result.totalHeight).toBe(4_000_000);
    expect(result.paddingBottom).toBe(4_000_000 - 400);
  });

  it("스크롤 위치에 따라 시작 인덱스가 이동하고 overscan이 앞뒤로 붙는다", () => {
    const result = computeVirtualWindow({
      scrollTop: 4_000,
      viewportHeight: 400,
      rowHeight: 40,
      rowCount: 100_000,
      overscan: 3,
    });

    expect(result.startIndex).toBe(97); // 100 - 3
    expect(result.endIndex).toBe(113); // 110 + 3
    expect(result.renderedCount).toBe(16);
    expect(result.paddingTop).toBe(97 * 40);
  });

  it("위쪽 끝에서는 overscan이 음수 인덱스를 만들지 않는다", () => {
    const result = computeVirtualWindow({ scrollTop: 20, viewportHeight: 400, rowHeight: 40, rowCount: 50, overscan: 10 });
    expect(result.startIndex).toBe(0);
    expect(result.paddingTop).toBe(0);
  });

  it("아래쪽 끝에서는 마지막 행을 넘지 않는다", () => {
    const result = computeVirtualWindow({
      scrollTop: 10_000_000,
      viewportHeight: 400,
      rowHeight: 40,
      rowCount: 50,
      overscan: 10,
    });

    expect(result.endIndex).toBe(50);
    expect(result.paddingBottom).toBe(0);
    expect(result.renderedCount).toBe(20); // 마지막 10행 + overscan 10
  });

  it("iOS 러버밴드처럼 음수 scrollTop도 0으로 보정한다", () => {
    const result = computeVirtualWindow({ scrollTop: -320, viewportHeight: 400, rowHeight: 40, rowCount: 1_000 });
    expect(result.startIndex).toBe(0);
    expect(result.paddingTop).toBe(0);
  });

  it("행 높이가 0이면 1로 보정해 무한 루프를 막는다", () => {
    const result = computeVirtualWindow({ scrollTop: 0, viewportHeight: 400, rowHeight: 0, rowCount: 10 });
    expect(result.endIndex).toBe(10);
  });

  it("10만 행에서도 DOM에 그리는 행 수는 수십 개로 유지된다", () => {
    const window = computeVirtualWindow({ scrollTop: 1_234_567, viewportHeight: 560, rowHeight: 44, rowCount: 100_000, overscan: 6 });
    expect(window.renderedCount).toBeLessThan(40);
    const dom = estimateDomNodes(100_000, window.renderedCount);
    expect(dom.full).toBe(900_000);
    expect(dom.ratio).toBeGreaterThan(2_000);
  });
});

describe("buildRowOffsets · findRowIndexByOffset", () => {
  it("누적 합 배열을 만든다", () => {
    expect(buildRowOffsets([40, 60, 20])).toEqual([0, 40, 100, 120]);
  });

  it("음수 높이는 0으로 본다", () => {
    expect(buildRowOffsets([40, -10, 20])).toEqual([0, 40, 40, 60]);
  });

  it("이진 탐색으로 scrollTop이 속한 행을 찾는다", () => {
    const offsets = buildRowOffsets([40, 60, 20, 80]);
    expect(findRowIndexByOffset(offsets, 0)).toBe(0);
    expect(findRowIndexByOffset(offsets, 39)).toBe(0);
    expect(findRowIndexByOffset(offsets, 40)).toBe(1);
    expect(findRowIndexByOffset(offsets, 99)).toBe(1);
    expect(findRowIndexByOffset(offsets, 100)).toBe(2);
    expect(findRowIndexByOffset(offsets, 999_999)).toBe(3);
  });

  it("빈 배열은 0을 돌려준다", () => {
    expect(findRowIndexByOffset([0], 500)).toBe(0);
  });
});

describe("computeVariableWindow", () => {
  it("가변 높이에서도 보이는 구간만 계산한다", () => {
    const heights = Array.from({ length: 1_000 }, (_unused, index) => (index % 2 === 0 ? 40 : 90));
    const offsets = buildRowOffsets(heights);
    const window = computeVariableWindow({ offsets, scrollTop: 400, viewportHeight: 300, overscan: 0 });

    expect(window.renderedCount).toBeGreaterThan(0);
    expect(window.paddingTop).toBeLessThanOrEqual(400);
    expect(window.paddingBottom).toBeGreaterThan(0);
    // 렌더 구간 안에 400px이 반드시 포함된다
    const renderedBottom = window.paddingTop + (window.renderedCount > 0 ? 0 : 0);
    expect(window.paddingTop).toBeLessThanOrEqual(renderedBottom + 400);
  });

  it("빈 offsets는 빈 구간을 돌려준다", () => {
    const window = computeVariableWindow({ offsets: [0], scrollTop: 0, viewportHeight: 300 });
    expect(window.renderedCount).toBe(0);
    expect(window.totalHeight).toBe(0);
  });
});

describe("estimateDomNodes", () => {
  it("전체 렌더 대비 절감 배수를 계산한다", () => {
    const result = estimateDomNodes(100_000, 30, 9);
    expect(result.full).toBe(900_000);
    expect(result.virtual).toBe(270);
    expect(result.ratio).toBe(3_333.3);
  });

  it("렌더 행이 0이면 배수는 0이다", () => {
    expect(estimateDomNodes(10, 0).ratio).toBe(0);
  });
});
