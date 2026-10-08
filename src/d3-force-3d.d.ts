// d3-force-3d ships no type declarations. This covers exactly the parts the plugin uses.
declare module "d3-force-3d" {
  export interface Force<N> {
    (alpha: number): void;
    initialize?(nodes: N[], ...rest: unknown[]): void;
  }

  export interface ForceLink<N, L> extends Force<N> {
    id(accessor: (node: N) => string): this;
    distance(d: number | ((link: L) => number)): this;
    strength(s: number | ((link: L) => number)): this;
    links(links: L[]): this;
  }

  export interface ForceManyBody<N> extends Force<N> {
    strength(s: number): this;
    theta(t: number): this;
    distanceMax(d: number): this;
  }

  export interface Simulation<N> {
    stop(): this;
    tick(iterations?: number): this;
    alpha(): number;
    alpha(a: number): this;
    alphaMin(): number;
    alphaTarget(t: number): this;
    alphaDecay(d: number): this;
    velocityDecay(d: number): this;
    nodes(): N[];
    nodes(nodes: N[]): this;
    force(name: string, force: Force<N> | null): this;
  }

  export function forceSimulation<N>(nodes?: N[], numDimensions?: number): Simulation<N>;
  export function forceLink<N, L>(links?: L[]): ForceLink<N, L>;
  export function forceManyBody<N>(): ForceManyBody<N>;
}
