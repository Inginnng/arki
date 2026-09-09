import type { ArchitectureGraph, ArchitectureEdge } from "@aimd/contracts";

/** A reading overview is a projection. Every omitted relation remains in the graph and document. */
export function architectureOverview(graph: ArchitectureGraph) {
  const preferred = graph.narrative?.edgeIds.map(id => graph.edges.find(edge => edge.id === id)!) ?? [];
  let spine: string[] = preferred.length ? [preferred[0]!.from, ...preferred.map(edge => edge.to)] : [];
  if (!spine.length) {
    const visit = (path: string[]) => {
      if (path.length > spine.length) spine = path;
      if (path.length >= 4) return;
      for (const edge of graph.edges.filter(edge => edge.from === path.at(-1))) if (!path.includes(edge.to)) visit([...path, edge.to]);
    };
    for (const node of [...graph.nodes].sort((a,b) => Number(b.kind === "frontend") - Number(a.kind === "frontend"))) visit([node.id]);
  }
  const connections: ArchitectureEdge[] = preferred.length ? [...preferred] : spine.slice(1).map((id,index) => graph.edges.find(edge => edge.from === spine[index] && edge.to === id)!);
  const order = [...spine];
  const anchors = new Map<string, string>();
  const ranked = [...graph.edges].sort((a,b) => Number(b.kind === "flow") - Number(a.kind === "flow"));
  while (order.length < graph.nodes.length) {
    const next = ranked.filter(edge => order.includes(edge.from) !== order.includes(edge.to)).sort((a,b) => Number(!order.includes(a.from)) - Number(!order.includes(b.from)))[0];
    if (!next) { order.push(graph.nodes.find(node => !order.includes(node.id))!.id); continue; }
    const parent = order.includes(next.from) ? next.from : next.to;
    const child = parent === next.from ? next.to : next.from;
    order.push(child); anchors.set(child, parent); connections.push(next);
  }
  const columns = Math.min(3, Math.max(1, spine.length, Math.ceil(Math.sqrt(graph.nodes.length))));
  const cells = new Map<string, { row: number; col: number }>();
  spine.forEach((id, index) => { const row = Math.floor(index / columns); const col = row % 2 ? columns - 1 - index % columns : index % columns; cells.set(id, { row, col }); });
  for (const id of order.filter(id => !cells.has(id))) {
    const anchor = cells.get(anchors.get(id) ?? "");
    let row = (anchor?.row ?? -1) + 1;
    let col = anchor?.col ?? 0;
    if (anchor) {
      const sibling = order.filter(other => other !== id && anchors.get(other) === anchors.get(id)).map(other => cells.get(other)).find(cell => cell && cell.row > anchor.row);
      if (sibling) row = sibling.row;
      const nearby = Array.from({ length: columns }, (_, index) => index).sort((a,b) => Math.abs(a-col) - Math.abs(b-col));
      col = nearby.find(candidate => ![...cells.values()].some(cell => cell.row === row && cell.col === candidate)) ?? columns;
      while ([...cells.values()].some(cell => cell.row === row && cell.col === col)) col++;
    } else {
      while ([...cells.values()].some(cell => cell.row === row && cell.col === col)) { col++; if (col >= columns) { col = 0; row++; } }
    }
    cells.set(id, { row, col });
  }
  // Unconnected modules occupy spare cells; they must not acquire invented arrows.
  const textWidth = (text: string, font: number) => [...text].reduce((width, ch) => width + (/[^\x00-\x7f]/u.test(ch) ? font : font * .58), 0);
  const nodeWidth = Math.max(220, ...graph.nodes.map(node => Math.ceil(Math.max(textWidth(node.label,18), textWidth(node.summary,13)) + 36)));
  const labelWidth = Math.max(92, ...connections.map(edge => textWidth(edge.label,13) + 32));
  const gapX = Math.max(128, labelWidth + 28);
  const gapY = 116;
  const components = order.map(id => {
    const node = graph.nodes.find(node => node.id === id)!;
    const { row, col } = cells.get(id)!;
    return { id, type: node.kind, label: node.label, sublabel: node.summary, ...(node.codeName && node.codeName !== node.label ? { tag: node.codeName } : {}), pos: [44 + col * (nodeWidth + gapX), 48 + row * (104 + gapY)], size: [nodeWidth, 104] };
  });
  const width = Math.max(480, ...components.map(node => node.pos[0]! + nodeWidth + 44));
  const height = Math.max(280, ...components.map(node => node.pos[1]! + 104 + 48));
  return { components, connections, order, width, height, primaryIds: new Set(connections.filter(edge => preferred.length ? preferred.some(item => item.id === edge.id) : spine.some((id,index) => id === edge.from && spine[index + 1] === edge.to)).map(edge => edge.id)) };
}
