/**
 * renderCount.ts — helpers for render-count assertions (U24).
 *
 * Two exports:
 *
 *   useRenderCount(name?)
 *     A hook that increments a ref on every render and returns the current
 *     count.  Starts at 1 (the initial mount render).  Safe to call from any
 *     function component inside a test.
 *
 *   withRenderCounter(Component, name)
 *     A higher-order component that wraps Component and exposes its render
 *     count via a React ref returned alongside the wrapped component.  Use the
 *     ref to read the count after an act() block:
 *
 *       const { WrappedComponent, countRef } = withRenderCounter(Foo, 'Foo');
 *       render(<WrappedComponent {...props} />);
 *       const before = countRef.current;
 *       act(() => triggerSomething());
 *       expect(countRef.current).toBe(before);  // zero additional renders
 *
 * Design notes:
 *   - The ref increment happens unconditionally on every render (no deps
 *     array), so it accurately tracks both initial renders and re-renders.
 *   - The HOC approach is preferred in the U24 tests because it lets the
 *     counter live outside the component under test — the test drives props
 *     via a parent wrapper, not by modifying the component itself.
 */

import { useRef, ComponentType, createElement, MutableRefObject } from 'react';

// ---------------------------------------------------------------------------
// useRenderCount
// ---------------------------------------------------------------------------

/**
 * Returns the number of times the calling component has rendered, starting
 * at 1 on initial mount.
 *
 * @param name - Optional label printed to console in CI debugging.
 */
export function useRenderCount(name?: string): number {
  const countRef = useRef(0);
  countRef.current += 1;

  if (name && process.env.DEBUG_RENDER_COUNT) {
    // eslint-disable-next-line no-console
    console.debug(`[renderCount] ${name} render #${countRef.current}`);
  }

  return countRef.current;
}

// ---------------------------------------------------------------------------
// withRenderCounter
// ---------------------------------------------------------------------------

export interface RenderCounterResult<P extends object> {
  /** The wrapped component — render this in tests. */
  WrappedComponent: ComponentType<P>;
  /** Mutable ref whose .current is the render count (starts at 1 on mount). */
  countRef: MutableRefObject<number>;
}

/**
 * Returns a HOC that wraps `Component` and tracks how many times it renders
 * into `countRef.current`.
 *
 * @param Component - The component under test.
 * @param name      - Display name for debugging.
 */
export function withRenderCounter<P extends object>(
  Component: ComponentType<P>,
  name: string,
): RenderCounterResult<P> {
  const countRef: MutableRefObject<number> = { current: 0 };

  function WrappedComponent(props: P) {
    countRef.current += 1;

    if (process.env.DEBUG_RENDER_COUNT) {
      // eslint-disable-next-line no-console
      console.debug(`[renderCount] ${name} render #${countRef.current}`);
    }

    return createElement(Component, props);
  }

  WrappedComponent.displayName = `WithRenderCounter(${name})`;

  return { WrappedComponent, countRef };
}
